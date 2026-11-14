#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSandbox, resolveRealDidaCmd, SKILL_NAME } from './lib/sandbox.mjs';
import { parseCmdShim } from './lib/shim.mjs';
import { buildSessionArgv, runSession, parseTranscript, sanitizeEnv, sessionCompleted, summarizeTranscript } from './lib/session.mjs';
import { defaultSettingsPath, ensureRunsDir, gitState, modelInfo, runId } from './lib/provenance.mjs';
import { listScenarios, loadScenario } from './lib/scenario.mjs';
import { decideAssertion, loadAssert } from './lib/assertion.mjs';
import { buildState } from './lib/state.mjs';
import { crossCheck, crossCheckStatus, outOfBoundsCalls, parseCallLog, rejectedCalls } from './lib/calllog.mjs';
import { readCreated } from './lib/created.mjs';
import { cleanRun } from './lib/cleanup.mjs';
import { resolveTestProjects } from './lib/projects.mjs';
import { formatValue, invalidLabel, renderReport } from './lib/report.mjs';

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

// 一条 run 的可信度结论：三面表的第一面，喂给 decideAssertion。
// 轨迹一条可解析的事件都没有时，shapeCalls 是 0，与「一次 PowerShell 都没调」看不出区别——
// 那种运行无从比较，判「无法判定」而不是「一致」。
//
// 只产出 status / detail / 条数，不产出 consistent 布尔：三态里「无从判定」时
// `logged >= shapeCalls` 可能为真，那个布尔与 status 相反，留在 manifest 里会误导读者。
export function credibilityOf({ calls, toolCalls, events }) {
  const checked = crossCheck(calls, toolCalls);
  const transcriptUsable = events.some((event) => event.type !== 'unparseable');
  const status = crossCheckStatus(checked, { transcriptUsable });
  return {
    status,
    calls: checked.calls,
    shapeCalls: checked.shapeCalls,
    // 轨迹读不出时那两个数是 0，报出来等于说「观测到 0 次调用」——那是没观测到的事实。
    detail: status === 'indeterminate'
      ? `轨迹 ${events.length} 条事件，没有一条能解析`
      : `${checked.calls} 条 dida 调用 / ${checked.shapeCalls} 次 PowerShell`,
  };
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

async function runOne(options, scenario, projects, assertionFn) {
  const id = scenario.id;
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
    testProjects: projects,
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
  // shim 靠这两个环境变量定位本 run 的账本。测试清单集合不走环境变量：
  // 被测 agent 能读也能改进程环境，白名单必须烘焙在沙箱配置里。
  env.DIDA_CALL_LOG = callLogPath;
  env.DIDA_CREATED_FILE = createdFile;
  const session = await runSession({ argv, cwd: sandbox.root, env, transcriptPath });

  const events = parseTranscript(transcriptPath);
  const summary = summarizeTranscript(events);
  const git = gitState(repoRoot);
  const sourceEnv = sandbox.anthropicEnv;
  const created = readCreated(createdFile);
  const calls = fs.existsSync(callLogPath) ? parseCallLog(fs.readFileSync(callLogPath, 'utf8')) : [];

  // 终态快照在清场之前取：清场删的正是这些任务，删完再取只能拿到 null。
  // 快照落盘供重放（用户故事 43）：断言改了之后不必再烧一次 API。
  // 取快照要枚举清单一，那一步失败不能带走整次运行——下面的 manifest 与清场
  // 必须照常执行，否则任务建在真实清单里却没人删。
  const statePath = path.join(runDir, 'state.json');
  let state = [];
  let stateFailed = false;
  let stateError = null;
  try {
    state = buildState({ dida: realDida(), created, projects });
  } catch (error) {
    // 用布尔表示「失败」，不靠 message 的真假：空格错误消息的 error 会让
    // 标志变 falsy，于是写下空的 state.json 并让断言在 [] 上判 FAILED。
    stateFailed = true;
    stateError = error.message || String(error);
  }
  // 取不到快照时不写 state.json：写一份空数组会让人以为「这次一条任务都没有」，
  // 重放时读出的是假事实。文件缺失才是诚实的。
  if (!stateFailed) fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const sessionInfo = {
    exitCode: session.exitCode,
    timedOut: session.timedOut,
    turns: summary.turns,
    costUsd: summary.costUsd,
  };
  const completed = sessionCompleted(session);
  // 五个状态的分界见 decideAssertion 的注释。判定本身不抛错，下面的 manifest 与清场总执行。
  const credibility = credibilityOf({ calls, toolCalls: summary.toolCalls, events });
  const assertion = await decideAssertion({
    completed,
    crossCheck: credibility,
    stateFailed,
    stateError,
    assertionFn,
    input: { tasks: state, created, calls, session: sessionInfo },
  });

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
      rejected: rejectedCalls(calls).length,
      outOfBounds: outOfBoundsCalls(calls).length,
      crossCheck: credibility,
    },
    created,
    // count 为 null 表示没取到快照，与「取到了、0 条」区分开。
    state: { path: statePath, count: stateFailed ? null : state.length, error: stateError },
    assertion,
    testProjects: projects,
    callerMarker: sandbox.callerMarker,
  };

  return { run: runKey, runDir, sandbox, manifest, session, createdFile };
}

// manifest 里带着断言模块返回的原值，那些值不受我们控制：循环引用、BigInt 都会让
// JSON.stringify 抛错。它抛在这里意味着清场还没跑——任务会留在真实清单里没人删。
// 所以先照常序列化；真抛了才降级，把环与 BigInt 一起折成占位串。
// 不预先做替换：JSON.stringify 的 replacer 拿不到「子树结束」的回调，用祖先链
// 会把同一对象在两个兄弟字段里各出现一次（expected 与 actual 指向同一份）误判成环。
function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    const onPath = new WeakSet();
    const substitute = (entry) => {
      if (typeof entry === 'bigint') return `${entry}n`;
      if (!entry || typeof entry !== 'object') return entry;
      if (onPath.has(entry)) return '[循环引用]';
      onPath.add(entry);
      const out = Array.isArray(entry)
        ? entry.map(substitute)
        : Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, substitute(v)]));
      // 只在「当前这条递归路径上」判环：兄弟字段共享同一对象是正常数据，不能标成环。
      onPath.delete(entry);
      return out;
    };
    return JSON.stringify(substitute(value), null, 2);
  }
}

export function writeManifest(runDir, manifest) {
  fs.writeFileSync(path.join(runDir, 'manifest.json'), safeStringify(manifest));
}

function writeReport(runDir, manifest) {
  fs.writeFileSync(path.join(runDir, 'report.md'), `${renderReport(manifest)}\n`);
}

// 用例配置错误也要留下报告：AC 要求报告里能读到原因，而不只是 stderr 一行。
// 不建沙箱、不开会话，只落一份最小 manifest 与报告。
export function writeUnusableRun(repoRoot, id, { skillPath, status, detail }) {
  const runKey = runId();
  const runDir = path.join(ensureRunsDir(repoRoot), runKey);
  fs.mkdirSync(runDir, { recursive: true });
  const manifest = {
    run: runKey,
    scenario: id,
    skill: { source: skillPath },
    assertion: { status, detail, results: [] },
    created: [],
    calls: {},
    session: {},
  };
  writeManifest(runDir, manifest);
  writeReport(runDir, manifest);
  return { runKey, runDir };
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
    // 缺 assert.mjs 不开会话：两个目录（scenarios/ 与 probes/）的区分就是有没有断言，
    // 跳过会让漏写的用例静默退出回归网、退出码仍是 0。这是用例配置错误，不是断言未通过。
    // loadScenario 单独拿出来：--scenario 写错 id 要报「找不到」，不能混成缺断言。
    let scenario;
    try {
      scenario = loadScenario(repoRoot, id);
    } catch (error) {
      console.error(`NOT FOUND ${id}  ${error.message}`);
      failures += 1;
      continue;
    }
    let assertionFn;
    try {
      assertionFn = await loadAssert(scenario.dir);
    } catch (error) {
      const { runKey, runDir } = writeUnusableRun(repoRoot, id, {
        skillPath: options.skillPath,
        status: 'broken',
        detail: error.message,
      });
      console.error(`MISCONFIGURED ${id}  断言模块加载失败：${error.message}（报告 ${path.relative(repoRoot, runDir)}，run=${runKey}）`);
      failures += 1;
      continue;
    }
    if (!assertionFn) {
      const assertPath = path.join(scenario.dir, 'assert.mjs');
      const { runKey, runDir } = writeUnusableRun(repoRoot, id, {
        skillPath: options.skillPath,
        status: 'missing',
        detail: `缺 ${assertPath}`,
      });
      console.error(`MISCONFIGURED ${id}  缺断言：${path.relative(repoRoot, assertPath)}（报告 ${path.relative(repoRoot, runDir)}，run=${runKey}）`);
      failures += 1;
      continue;
    }

    const { run, runDir, sandbox, manifest, session, createdFile } = await runOne(options, scenario, projects, assertionFn);
    const completed = sessionCompleted(session);

    const retained = !completed || options.keepSandbox || options.hold;

    // 先把会话事实落盘，再动清单：清场读账本出错时，manifest 与 report 必须已经在了。
    writeManifest(runDir, { ...manifest, cleanup: null, sandboxRetained: retained });

    // 只按账本删。会话没正常结束时连任务一起保留现场，由 --clean 显式收尾。
    let cleanup;
    try {
      cleanup = options.hold || !completed
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
    // 除 passed 外都要非零：failed 是 skill 有缺陷，broken 是用例有缺陷，
    // invalid 是结果不可用（快照取不到、日志与轨迹对不上，或轨迹读不出）——三者都要人看一眼，不能安静地算通过。
    if (!completed || cleanupProblem || manifest.assertion.status !== 'passed') failures += 1;

    const verdict = {
      passed: 'PASSED',
      skipped: 'INCOMPLETE',
      failed: 'FAILED',
      broken: 'BROKEN',
      invalid: 'INVALID',
    }[manifest.assertion.status];
    console.log(`${verdict} ${id}  run=${run}`);
    console.log(`  skill sha256=${manifest.skill.sha256.slice(0, 16)} files=${manifest.skill.files} git=${manifest.skill.git.rev?.slice(0, 12)}${manifest.skill.git.dirty ? ' (dirty)' : ''}`);
    console.log(`  model alias=${manifest.model.requested_alias} provider=${manifest.model.provider}（别名不等于实际执行模型，真实映射见 manifest.model.alias_mapping）`);
    console.log(`  sandbox=${sandbox.root}${retained ? ' (retained)' : ' (removed)'}`);
    console.log(`  transcript=${path.relative(repoRoot, manifest.transcript.path)} events=${manifest.transcript.events} toolCalls=${manifest.transcript.toolCalls}`);
    console.log(`  calls=${path.relative(repoRoot, manifest.calls.path)} total=${manifest.calls.total} rejected=${manifest.calls.rejected} outOfBounds=${manifest.calls.outOfBounds}`);
    console.log(`  created=${manifest.created.length} 条${manifest.created.length ? '：' + manifest.created.map((e) => e.id).join('、') : ''}`);
    console.log(manifest.state.error
      ? `  state=未落盘（${manifest.state.error}）`
      : `  state=${path.relative(repoRoot, manifest.state.path)}（${manifest.state.count} 条）`);
    // invalid 的失败项指向 harness 自己（快照取不到 / 调用日志对不上 / 轨迹读不出），
    // 不是断言不通过——措辞要分开，否则控制台会把基础设施故障或防护缺陷读成 skill 缺陷。
    for (const result of manifest.assertion.results.filter((r) => !r.ok)) {
      const label = manifest.assertion.status === 'invalid' ? invalidLabel(manifest.assertion.cause) : '断言未通过';
      console.error(`    ${label} ${result.name}：期望 ${formatValue(result.expected)}，实际 ${formatValue(result.actual)}`);
    }
    // 可信度失败时断言照样跑了，把结论也打出来：否则一次真实的 skill 回归
    // 在控制台上只剩一句「结果不可信」。
    const evaluated = manifest.assertion.evaluated;
    if (evaluated) {
      if (evaluated.status === 'failed') {
        console.error('    同一份终态下，结局断言未通过：');
        for (const result of evaluated.results.filter((r) => !r.ok)) {
          console.error(`      断言未通过 ${result.name}：期望 ${formatValue(result.expected)}，实际 ${formatValue(result.actual)}`);
        }
      } else {
        console.error(`    同一份终态下，结局断言 ${evaluated.status}（不影响上面的结论）`);
      }
    }
    reportCleanup(cleanup, run);
    console.log(`  caller marker=${manifest.callerMarker}`);
    console.log(`  run dir=${path.relative(repoRoot, runDir)}`);
    if (!completed) console.log(`  session exit=${session.exitCode} timedOut=${session.timedOut}`);
  }

  if (failures > 0) process.exitCode = 1;
}

// 作为模块被测试 import 时不要执行 main；只有直接运行时才进 CLI。
// 用 import.meta.main 而非比较 process.argv[1]：经 junction / 符号链接调用时
// argv[1] 是链接路径、import.meta.url 是真实路径，比较不成立会静默空跑。
if (import.meta.main) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
