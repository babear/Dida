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
import { parseCallLog } from './lib/calllog.mjs';
import { readCreated } from './lib/created.mjs';
import { cleanRun, inspectProjects } from './lib/cleanup.mjs';
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

function projectsSnapshot(dida, projects) {
  const tasksByProject = {};
  for (const projectId of projects) {
    const result = dida.run(['task', 'filter', '--projects', projectId, '--json']);
    if (result.exitCode !== 0) {
      throw new Error(`读清单 ${projectId} 失败：${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
    const text = result.stdout.trim();
    tasksByProject[projectId] = text ? JSON.parse(text) : [];
  }
  return tasksByProject;
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
  const createdFile = path.join(runDir, 'created.json');
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
    calls: { path: callLogPath, total: calls.length, unparseable: calls.filter((c) => c.unparseable).length },
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
  const projects = resolveTestProjects();
  const dida = realDida();

  // 清场子命令：只按 created.json 删，遇到未记账任务就停下。
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
      createdFile: path.join(runDir, 'created.json'),
    });
    const updated = { ...manifest, cleanup };
    writeManifest(runDir, updated);
    writeReport(runDir, updated);
    if (cleanup.aborted) {
      console.error(`清场停止：清单里有 ${cleanup.foreign.length} 条非本 run 创建的任务，未删除。`);
      for (const entry of cleanup.foreign) console.error(`  ${entry.projectId} ${entry.id} ${entry.title ?? ''}`);
      process.exitCode = 1;
      return;
    }
    console.log(`已删除 ${cleanup.deleted.length} 条，失败 ${cleanup.failed.length} 条`);
    for (const entry of cleanup.failed) console.error(`  删除失败 ${entry.projectId} ${entry.id}: ${entry.stderr}`);
    if (cleanup.failed.length > 0) process.exitCode = 1;
    return;
  }

  const ids = options.scenario ? [options.scenario] : listScenarios(repoRoot);
  if (ids.length === 0) {
    console.error('no scenarios found');
    process.exitCode = 1;
    return;
  }

  // 运行前检查：清单不空就拒绝开跑并列出可疑任务。绝不自动清空。
  const preliminary = inspectProjects(projects, projectsSnapshot(dida, projects));
  if (!preliminary.ok) {
    console.error('测试清单不为空，拒绝开跑：');
    for (const entry of preliminary.foreign) {
      console.error(`  ${entry.projectId} ${entry.id} ${entry.title ?? '（无标题）'}`);
    }
    console.error('确认这些任务的去留后，用 --clean <runId> 只清理本 harness 建过的，或手动处置。');
    process.exitCode = 1;
    return;
  }

  let failures = 0;
  for (const id of ids) {
    const { run, runDir, sandbox, manifest, session, createdFile } = await runOne(options, id, projects);
    const sessionCompleted = session.exitCode === 0 && !session.timedOut;

    // 清场只按 created.json 删；失败现场默认保留，--clean 显式收尾。
    const cleanup = options.hold
      ? { aborted: false, deleted: [], failed: [], foreign: [] }
      : cleanRun({ dida: realDida(), projects, createdFile });
    const retained = !sessionCompleted || options.keepSandbox || options.hold;
    const finalManifest = { ...manifest, cleanup, sandboxRetained: retained };
    writeManifest(runDir, finalManifest);
    writeReport(runDir, finalManifest);
    if (!retained) fs.rmSync(sandbox.root, { recursive: true, force: true });
    if (!sessionCompleted || cleanup.aborted || cleanup.failed.length > 0) failures += 1;

    console.log(`${sessionCompleted ? 'COMPLETED' : 'INCOMPLETE'} ${id}  run=${run}`);
    console.log(`  skill sha256=${manifest.skill.sha256.slice(0, 16)} files=${manifest.skill.files} git=${manifest.skill.git.rev?.slice(0, 12)}${manifest.skill.git.dirty ? ' (dirty)' : ''}`);
    console.log(`  model alias=${manifest.model.requested_alias} provider=${manifest.model.provider}（别名不等于实际执行模型，真实映射见 manifest.model.alias_mapping）`);
    console.log(`  sandbox=${sandbox.root}${retained ? ' (retained)' : ' (removed)'}`);
    console.log(`  transcript=${path.relative(repoRoot, manifest.transcript.path)} events=${manifest.transcript.events} toolCalls=${manifest.transcript.toolCalls}`);
    console.log(`  calls=${path.relative(repoRoot, manifest.calls.path)} total=${manifest.calls.total}`);
    console.log(`  created=${manifest.created.length} 条${manifest.created.length ? '：' + manifest.created.map((e) => e.id).join('、') : ''}`);
    console.log(`  cleanup deleted=${cleanup.deleted.length} failed=${cleanup.failed.length}${cleanup.aborted ? ` 已停止（${cleanup.foreign.length} 条未记账）` : ''}`);
    console.log(`  caller marker=${manifest.callerMarker}`);
    console.log(`  run dir=${path.relative(repoRoot, runDir)}`);
    if (!sessionCompleted) console.log(`  session exit=${session.exitCode} timedOut=${session.timedOut}`);
  }

  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
