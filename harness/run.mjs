#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSandbox, resolveRealDidaCmd, SKILL_NAME } from './lib/sandbox.mjs';
import { parseCmdShim } from './lib/shim.mjs';
import { buildSessionArgv, runSession, parseTranscript, sanitizeEnv, summarizeTranscript } from './lib/session.mjs';
import { defaultSettingsPath, ensureRunsDir, gitState, modelInfo, runId } from './lib/provenance.mjs';
import { listScenarios, loadScenario } from './lib/scenario.mjs';
import { crossCheck, parseCallLog } from './lib/calllog.mjs';
import { readCreated } from './lib/created.mjs';
import { cleanRun } from './lib/cleanup.mjs';
import { resolveTestProjects } from './lib/projects.mjs';
import { renderReport } from './lib/report.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_SOURCE_PATH = path.join(repoRoot, 'harness', 'agents.json');

function parseArgs(argv) {
  const options = {
    scenario: null,
    skillPath: path.join(repoRoot, 'skills', SKILL_NAME),
    settingsPath: defaultSettingsPath(),
    keepSandbox: false,
    clean: null,
    hold: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === '--scenario') options.scenario = next();
    else if (arg === '--skill-path') options.skillPath = path.resolve(next());
    else if (arg === '--settings') options.settingsPath = path.resolve(next());
    else if (arg === '--keep-sandbox') options.keepSandbox = true;
    else if (arg === '--clean') options.clean = next();
    else if (arg === '--hold') options.hold = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

// 清场直接调真 CLI。node 24 起 spawnSync 不允许直接执行 .cmd（EINVAL），
// 所以这里复用它自己的入口：从 .cmd 解析出 node + script，绕开 cmd。
function realDida() {
  const cmd = resolveRealDidaCmd();
  if (!cmd) throw new Error('找不到真 dida.cmd；设置 DIDA_CMD 指向它');
  const parsed = parseCmdShim(fs.readFileSync(cmd, 'utf8'), path.dirname(cmd));
  if (!parsed) throw new Error(`无法从 ${cmd} 解析出 CLI 入口`);
  return {
    run: (argv) => {
      const result = spawnSync(parsed.program, [parsed.script, ...argv], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? 1 };
    },
  };
}

function emptyCleanup(overrides = {}) {
  return { deleted: [], failed: [], remaining: [], mismatched: [], ...overrides };
}

// 清场出问题只影响这一条 run 的退出码，不阻断后续 scenario：账本按 runId 隔离。
// mismatched 不算问题：任务已按实况删掉，账本记的清单不同只是记录出入（ADR-0010）。
export function hasCleanupProblem(cleanup) {
  return Boolean(cleanup.error)
    || cleanup.failed.length > 0
    || cleanup.remaining.length > 0;
}

function reportCleanup(cleanup, run) {
  if (cleanup.deferred) {
    console.log(`  cleanup 未清场${run ? `（用 --clean ${run} 收尾）` : ''}`);
    return;
  }
  if (cleanup.error) {
    console.log(`  cleanup 未执行：${cleanup.error}`);
    return;
  }
  console.log(`  cleanup deleted=${cleanup.deleted.length} failed=${cleanup.failed.length} remaining=${cleanup.remaining.length}`);
  for (const entry of cleanup.failed) console.error(`    删除失败 ${entry.projectId} ${entry.id}: ${entry.stderr}`);
  for (const id of cleanup.remaining) console.error(`    删除后仍在清单里 ${id}`);
  for (const entry of cleanup.mismatched) {
    console.error(`    账本记在 ${entry.recordedAt}、实际在 ${entry.actual}：${entry.id}（按实际清单删）`);
  }
}

async function runOne(options, id, projects) {
  const scenario = loadScenario(repoRoot, id);
  const runKey = runId();
  const runsDir = ensureRunsDir(repoRoot);
  const runDir = path.join(runsDir, runKey);
  fs.mkdirSync(runDir, { recursive: true });

  const sandbox = createSandbox({
    runId: runKey,
    skillPath: options.skillPath,
    agentsSourcePath: AGENTS_SOURCE_PATH,
    scenario,
    settingsPath: options.settingsPath,
  });

  const transcriptPath = path.join(runDir, 'trace.ndjson');
  const callLogPath = path.join(runDir, 'calls.ndjson');
  const createdFile = path.join(runDir, 'created.ndjson');
  const argv = buildSessionArgv({
    prompt: scenario.prompt,
    agentsPath: sandbox.agentsPath,
  });

  const env = { ...sanitizeEnv(process.env), CLAUDE_CONFIG_DIR: sandbox.configDir };
  env.PATH = `${sandbox.binDir}${path.delimiter}${env.PATH ?? ''}`;
  // shim 靠这两个环境变量记账；它们在沙箱会话里可见，但只指向本 run 的账本，不含断言内容。
  env.DIDA_CALL_LOG = callLogPath;
  env.DIDA_CREATED_FILE = createdFile;
  const session = await runSession({ argv, cwd: sandbox.root, env, transcriptPath });

  const events = parseTranscript(transcriptPath);
  const summary = summarizeTranscript(events);
  const git = gitState(repoRoot);
  const sourceEnv = sandbox.anthropicEnv;
  const calls = fs.existsSync(callLogPath) ? parseCallLog(fs.readFileSync(callLogPath, 'utf8')) : [];

  const manifest = {
    run: runKey,
    scenario: id,
    sandbox: sandbox.root,
    skill: {
      source: options.skillPath,
      sha256: sandbox.skillFingerprint.sha256,
      files: sandbox.skillFingerprint.files,
      git,
    },
    model: modelInfo(sourceEnv, summary.modelAlias),
    session: {
      exitCode: session.exitCode,
      timedOut: session.timedOut,
      sessionId: summary.sessionId,
      tools: summary.tools,
      turns: summary.turns,
      costUsd: summary.costUsd,
      stderr: session.stderr.slice(0, 4000),
    },
    transcript: { path: transcriptPath, events: events.length, toolCalls: summary.toolCalls.length },
    calls: {
      path: callLogPath,
      total: calls.length,
      unparseable: calls.filter((c) => c.unparseable).length,
      crossCheck: crossCheck(calls, summary.toolCalls),
    },
    created: readCreated(createdFile),
    testProjects: projects,
    callerMarker: sandbox.callerMarker,
  };

  return { run: runKey, runDir, sandbox, manifest, session, createdFile };
}

function writeManifest(runDir, manifest) {
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function writeReport(runDir, manifest) {
  fs.writeFileSync(path.join(runDir, 'report.md'), `${renderReport(manifest)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`用法：
  node harness/run.mjs [--scenario <id>] [--skill-path <dir>] [--settings <file>] [--keep-sandbox] [--hold]
  node harness/run.mjs --clean <runId>

  --scenario <id>     只跑这一条 scenario（默认全部）
  --skill-path <dir>  复制进沙箱的 skill 目录（默认 skills/dida-cli）
  --settings <file>   取 ANTHROPIC_* 键的来源（默认 ~/.claude/settings.json）
  --keep-sandbox      成功时也保留沙箱
  --hold              跑完不清场，留现场
  --clean <runId>     只按该 run 的 created.ndjson 删除任务，然后退出`);
    return;
  }
  const projects = resolveTestProjects();
  const dida = realDida();

  // 清场子命令：只按账本删。
  if (options.clean) {
    const runDir = path.join(ensureRunsDir(repoRoot), options.clean);
    if (!fs.existsSync(runDir)) {
      console.error(`run 不存在：${options.clean}`);
      process.exitCode = 1;
      return;
    }
    const manifestPath = path.join(runDir, 'manifest.json');
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
    const cleanup = cleanRun({
      dida: realDida(),
      projects: manifest.testProjects ?? projects,
      createdFile: path.join(runDir, 'created.ndjson'),
    });
    const updated = { ...manifest, cleanup };
    writeManifest(runDir, updated);
    writeReport(runDir, updated);
    reportCleanup(cleanup);
    if (hasCleanupProblem(cleanup)) process.exitCode = 1;
    return;
  }

  const ids = options.scenario ? [options.scenario] : listScenarios(repoRoot);
  if (ids.length === 0) {
    console.error('no scenarios found');
    process.exitCode = 1;
    return;
  }

  let failures = 0;
  for (const id of ids) {
    const { run, runDir, sandbox, manifest, session, createdFile } = await runOne(options, id, projects);
    const sessionCompleted = session.exitCode === 0 && !session.timedOut;

    const retained = !sessionCompleted || options.keepSandbox || options.hold;

    // 先把会话事实落盘，再动清单：清场读账本出错时，manifest 与 report 必须已经在了。
    writeManifest(runDir, { ...manifest, cleanup: null, sandboxRetained: retained });

    // 只按账本删。会话没正常结束时连任务一起保留现场，由 --clean 显式收尾。
    let cleanup;
    try {
      cleanup = options.hold || !sessionCompleted
        ? emptyCleanup({ deferred: true })
        : cleanRun({ dida: realDida(), projects, createdFile });
    } catch (error) {
      cleanup = emptyCleanup({ error: error.message });
    }
    const finalManifest = { ...manifest, cleanup, sandboxRetained: retained };
    writeManifest(runDir, finalManifest);
    writeReport(runDir, finalManifest);
    if (!retained) fs.rmSync(sandbox.root, { recursive: true, force: true });

    // 清场失败只记 log 不中断：每条 scenario 的账本按 runId 隔离，删不掉自己的那几条
    // 不会影响下一条的判断。退出码仍非零，让人知道有现场要收。
    const cleanupProblem = hasCleanupProblem(cleanup);
    if (!sessionCompleted || cleanupProblem) failures += 1;

    console.log(`${sessionCompleted ? 'COMPLETED' : 'INCOMPLETE'} ${id}  run=${run}`);
    console.log(`  skill sha256=${manifest.skill.sha256.slice(0, 16)} files=${manifest.skill.files} git=${manifest.skill.git.rev?.slice(0, 12)}${manifest.skill.git.dirty ? ' (dirty)' : ''}`);
    console.log(`  model alias=${manifest.model.requested_alias} provider=${manifest.model.provider}（别名不等于实际执行模型，真实映射见 manifest.model.alias_mapping）`);
    console.log(`  sandbox=${sandbox.root}${retained ? ' (retained)' : ' (removed)'}`);
    console.log(`  transcript=${path.relative(repoRoot, manifest.transcript.path)} events=${manifest.transcript.events} toolCalls=${manifest.transcript.toolCalls}`);
    console.log(`  calls=${path.relative(repoRoot, manifest.calls.path)} total=${manifest.calls.total}`);
    console.log(`  created=${manifest.created.length} 条${manifest.created.length ? '：' + manifest.created.map((e) => e.id).join('、') : ''}`);
    reportCleanup(cleanup, run);
    console.log(`  caller marker=${manifest.callerMarker}`);
    console.log(`  run dir=${path.relative(repoRoot, runDir)}`);
    if (!sessionCompleted) console.log(`  session exit=${session.exitCode} timedOut=${session.timedOut}`);
  }

  if (failures > 0) process.exitCode = 1;
}

// 作为模块被测试 import 时不要执行 main；只有直接运行时才进 CLI。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
