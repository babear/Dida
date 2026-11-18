#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSandbox, resolveRealDidaCmd, SKILL_NAME } from './lib/sandbox.mjs';
import { parseCmdShim } from './lib/shim.mjs';
import { buildSessionArgv, runSession, parseTranscript, sanitizeEnv, sessionCompleted, summarizeTranscript } from './lib/session.mjs';
import { defaultSettingsPath, ensureRunsDir, gitState, modelInfo, runId } from './lib/provenance.mjs';
import { listProbes, listScenarios, loadScenario } from './lib/scenario.mjs';
import { decideAssertion, loadAssert, loadProcessAssert, takeSample } from './lib/assertion.mjs';
import { buildState } from './lib/state.mjs';
import { countRejectedReasons, crossCheck, crossCheckStatus, outOfBoundsCalls, parseCallLog, rejectedCalls } from './lib/calllog.mjs';
import { readCreated } from './lib/created.mjs';
import { cleanRun } from './lib/cleanup.mjs';
import { runPreset } from './lib/preset.mjs';
import { resolveTestProjects } from './lib/projects.mjs';
import { batchSummaryLines, summarizeBatch } from './lib/batch.mjs';
import { formatValue, INCOMPLETE_FACT, invalidLabel, renderReport, retentionNote } from './lib/report.mjs';

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

// PATH 前置一个目录，复用已有的那个 path 键（Windows 上键名大小写不定，见 #36）。
// 找不到才新建 `PATH`：非 Windows 平台继承来的通常就是它。
export function withPrependedPath(env, dir) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...env, [key]: `${dir}${path.delimiter}${env[key] ?? ''}` };
}

function emptyCleanup(overrides = {}) {
  return { deleted: [], failed: [], remaining: [], mismatched: [], ...overrides };
}

// 清场门控（ADR-0014）：只有 PASSED 才清场，其余一律保留现场。
// 门控看判定结论，不看会话退出码——一次 invalid 的运行会话可能正常结束，
// 按退出码判会把它清掉，而它的账本恰恰可能盖不全（绕过 shim 建的任务清不掉）。
// hold 是操作者的显式要求（--hold：跑完不清场），与判定结论无关。
// 运行目录保留是另一件事：--keep-sandbox 只留目录、照常清场（见 README 的参数表）。
//
// 探针永不清场（ADR-0015）：按 kind 判而不是靠「探针结论不是 passed」这个巧合——
// 探针将来多一个结论词，清场就会悄悄漏进来。
export function cleanupGate({ status, hold = false, kind = 'scenario' }) {
  if (kind === 'probe') return true;
  return status !== 'passed' || hold;
}

// 保留现场时控制台的那一行。措辞与报告同源（retentionNote），
// AC 要求两处都能读到同一句「现场已保留，用 --clean <runId> 收尾」。
export function deferredCleanupLine(run) {
  return run ? `  cleanup 未清场（${retentionNote(run)}）` : '  cleanup 未清场（现场已保留）';
}

// 批跑汇总：失败即留现场，跑十条挂六条就是六批任务。没有这份清单，
// 人下次打开客户端无从追溯该收哪几条。
// 入列条件是「现场确实留了」，不是「没通过」：--hold 下通过的运行也留了现场，
// 同样需要人收尾。所以由调用方按 defer 决定入列，这里只负责渲染。
export function retainedSummaryLines(entries) {
  if (entries.length === 0) return [];
  return [
    `本次有 ${entries.length} 条现场已保留：`,
    ...entries.map((entry) => `  ${entry.run}  ${entry.scenario}  ${entry.status}`),
    '  确认后用 --clean <runId> 逐条收尾。',
  ];
}

// 全量运行不碰 probes/（ADR-0015），但 probes/ 里有残留说明流程没走完：
// 断言写好了却没搬进 scenarios/，回归网就静默少一条。这是流程提醒，不是失败。
export function probesLeftoverLines(ids) {
  if (ids.length === 0) return [];
  return [
    `skill-tests/probes/ 里还有 ${ids.length} 条探针：${ids.join('、')}。`,
    '  断言写好之后把它们搬进 scenarios/，否则它们不进回归网。',
  ];
}

// 探针目录里的 assert.mjs 不执行（ADR-0012）。静默忽略会让「写了断言却没结论」
// 变成一次无声的困惑——排查的人会先怀疑 harness。只提示，不报错。
export function probeAssertNotice(scenario) {
  if (scenario.kind !== 'probe' || !scenario.hasAssert) return null;
  return `  提示：${path.join(scenario.dir, 'assert.mjs')} 未被使用——断言只在 scenarios/ 生效。`;
}

// 一条 run 的可信度结论：三面表的第一面，喂给 decideAssertion。
// 轨迹读不出任何可解析事件时，判据没有可比对的对象，判「无法判定」而不是「一致」。
//
// 只产出 status / detail / 统计，不产出 consistent 布尔：三态里「无从判定」时
// 旧布尔可能为真，与 status 相反，留在 manifest 里会误导读者。
export function credibilityOf({ calls, toolCalls, events, shimDir = null }) {
  const checked = crossCheck(calls, toolCalls, { shimDir });
  const transcriptUsable = events.some((event) => event.type !== 'unparseable');
  const status = crossCheckStatus(checked, { transcriptUsable });
  return {
    status,
    detail: credibilityDetail({ status, checked, events, transcriptUsable }),
    // 报告要能指向证据：读者得自己核对是哪几次调用没对上（#18 移交的第 3 条）。
    unmatched: checked.unmatched ?? [],
    reason: checked.reason,
  };
}

function credibilityDetail({ status, checked, events, transcriptUsable }) {
  // 「一条事件都没有」与「有事件但全是垃圾」的指引相反：前者大概率是 CLI 没吐出东西、
  // 重跑能好；后者是解析器或 harness 的缺陷，重跑没用（#18 移交的第 4 条）。
  if (!transcriptUsable) {
    return events.length === 0
      ? '轨迹里一条事件都没有（CLI 可能一启动就崩了），重跑一次'
      : `轨迹 ${events.length} 条事件，没有一条能解析（查解析器/harness，重跑没用）`;
  }
  if (status === 'consistent') return '轨迹里的 dida 调用在日志里都有对应';
  if (status === 'indeterminate') {
    return checked.reason === 'unparsed'
      ? '轨迹里有命令解析不出是不是 dida 调用（变量、拼接等），无从比对'
      : '轨迹里的 PowerShell 调用没有命令文本，无从比对';
  }
  const listed = (checked.unmatched ?? []).map((call) => call.argv.join(' ')).join('；');
  return `${checked.unmatched.length} 次 dida 调用在日志里找不到对应：${listed}`;
}

// 清场出问题只影响这一条 run 的退出码，不阻断后续 scenario：账本按 runId 隔离。
// mismatched 不算问题：任务已按实况删掉，账本记的清单不同只是记录出入（ADR-0010）。
export function hasCleanupProblem(cleanup) {
  return Boolean(cleanup.error)
    || cleanup.failed.length > 0
    || cleanup.remaining.length > 0;
}

// 重试（#9）：只重试「会话没正常结束」——那是运行器自己没跑完，重来一次才有意义。
// 断言未通过（failed）与结果不可用（invalid）都是**结论**，要停下看原因，不是把结论
// 推迟一次；broken / missing / preset-failed 是用例写错了，重跑不会变绿。
// 单次全绿是否偶然归 #26 的多次运行，这里不给 passed 套重试。
// 探针不重试：它没有判定要守，重跑只是再烧一次钱。
const MAX_ATTEMPTS = 2;

export function shouldRetry({ status, kind = 'scenario' }) {
  if (kind === 'probe') return false;
  return status === 'incomplete';
}

// 终态快照的构建。**要不要取由判定链决定**（assertion.mjs 的 decideAssertion）：
// 会话正常结束是前置门、可信度检查通过是第二道，两道都过了才轮到这里。这里只负责
// 取一次并落盘，不自己再判一遍——两处各判一次，就会出现「判定链说没取、这里说取了」。
//
// 取失败时不写文件：写一份空数组会让人以为「这次一条任务都没有」，重放时读出的是假事实。
// 文件缺失才是诚实的。写盘本身也可能失败（磁盘满、权限），同样折成 failed 而不是抛出——
// 抛出会让判定链中断，manifest 落不下、清场不跑，任务就留在真实清单里没人删。
//
// error 与 status 分开：错误消息可能是空串，靠 message 的真假判失败会把
// 空消息的 error 当成成功，写下空 state.json 并让断言在 [] 上判 FAILED。
//
// 取失败时再取一次（#9）：会话已经跑完了，重跑整条是浪费一次真实 API；
// 该重试的只是「取快照」这个动作（基础设施抖动）。同一个 build 跑两遍，
// 第二次成功就用它；都失败才落 status: 'failed'，留下的是最后一次的错误。
//
// `failed` 是**这一层**的状态词（取的动作失败了），不是判定结论：判定链
// （assertion.mjs）把「快照取不到」折成 invalid（cause: state），因为它的含义是
// 「结果不可用」而不是「skill 没做到」（ADR-0014）。两层各说各的，别对读。
const STATE_ATTEMPTS = 2;

export function takeState({ statePath, build }) {
  let lastError = null;
  for (let attempt = 0; attempt < STATE_ATTEMPTS; attempt += 1) {
    try {
      const state = build();
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return { status: 'ok', state, error: null };
    } catch (error) {
      lastError = error;
    }
  }
  return { status: 'failed', state: [], error: lastError.message || String(lastError) };
}

// 控制台上的快照那一行。三种情形各说各的：没取（判定链在前一面就停了）、取了但失败
// （故障）、取到了。把前两种混成「未落盘」会让人把「没开始」读成「取失败」，
// 而它们的处理方式相反。没取的原因（前置门 / 可信度）由判定那一行负责说明。
export function stateLine(manifest) {
  const state = manifest.state ?? {};
  if (state.status === 'not-taken') return '  state=未取（判定链在前一面就停了）';
  if (state.status === 'failed') return `  state=未落盘（${state.error}）`;
  return `  state=${path.relative(repoRoot, state.path ?? '')}（${state.count} 条）`;
}

function reportCleanup(cleanup, run) {
  if (cleanup.deferred) {
    console.log(deferredCleanupLine(run));
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

// 判定的控制台行。抽成纯函数才能测：一次运行只给一个结论（ADR-0014），
// 可信度失败时这里只该有第一面那组失败项，不该再并排一行断言结论。
// 报告侧同口径，见 report.mjs 的 renderVerdict。
export function verdictLines(assertion) {
  const lines = [];
  // 前置门没过时说清「什么都没判」，否则控制台上会只剩一行 INCOMPLETE 让人去猜。
  if (assertion.status === 'incomplete') lines.push(`    会话没正常结束，判定链未开始：${INCOMPLETE_FACT}。`);
  // invalid 的失败项指向 harness 自己（快照取不到 / 调用日志对不上 / 轨迹读不出），
  // 不是断言不通过——措辞要分开，否则控制台会把基础设施故障或防护缺陷读成 skill 缺陷。
  // 结局断言与过程断言（第三面）都判 failed，也各有各的说法：
  // 前者是「没做到」，后者是「做到了但绕了远路」（ADR-0005）。
  // 过程断言的结果在 process.results 里，results 只放结局断言那几条。
  const failed = assertion.surface === 'process'
    ? (assertion.process?.results ?? []).filter((r) => !r.ok)
    : assertion.results.filter((r) => !r.ok);
  for (const result of failed) {
    const label = assertion.status === 'invalid'
      ? invalidLabel(assertion.cause)
      : (assertion.surface === 'process' ? '过程断言未通过' : '断言未通过');
    lines.push(`    ${label} ${result.name}：期望 ${formatValue(result.expected)}，实际 ${formatValue(result.actual)}`);
  }
  return lines;
}


// 会话进程的启动参数。cwd 取 work/ 而不是整个运行目录——shim、配置、工具面定义都在
// 它的上一层，agent 列目录只看得到 materials/（#16）。这条装配关系是本改动的
// 全部意义所在：它若改回 sandbox.root，agent 就重新看得到 shim 与配置。
export function sessionEnvOf({ sandbox, callLogPath, createdFile }) {
  // Windows 继承来的键名大小写不定（可能是 `Path`），直接写 `env.PATH` 会新增一个同名
  // 不同大小写的键，spawn 时后者胜出、继承的 PATH 整个丢掉：运行目录里裸 node 就找不到了。
  // 必须复用已有的那个键。见 #36。
  const env = withPrependedPath(
    { ...sanitizeEnv(process.env), CLAUDE_CONFIG_DIR: sandbox.configDir },
    sandbox.binDir,
  );
  // shim 靠这两个环境变量定位本 run 的账本。测试清单集合不走环境变量：
  // 被测 agent 能读也能改进程环境，白名单必须烘焙在运行目录的配置里。
  env.DIDA_CALL_LOG = callLogPath;
  env.DIDA_CREATED_FILE = createdFile;
  return env;
}

export async function runOneSession({ argv, sandbox, callLogPath, createdFile, transcriptPath }) {
  const env = sessionEnvOf({ sandbox, callLogPath, createdFile });
  return runSession({ argv, cwd: sandbox.workDir, env, transcriptPath });
}

// 加载一条用例的断言模块。探针不跑断言（ADR-0015）：目录里有 assert.mjs 也不加载，
// 那是留给搬进 scenarios/ 之后的草稿——缺它更不是错误，这正是探针与 scenario 的分别。
//
// 过程断言是可选件：没有规则目录是正常的（结论标「过程未判」），加载失败才是用例写错了。
// 两条断言一起在这里加载，是因为它们对编排层是同一件事——任一加载失败，这条用例就不跑。
export async function loadScenarioAssertions(scenario) {
  if (scenario.kind === 'probe') return { assertionFn: null, processFn: null };
  const assertionFn = await loadAssert(scenario.dir);
  const processFn = await loadProcessAssert(scenario.dir);
  return { assertionFn, processFn };
}

async function runOne(options, scenario, projects, assertionFn, processFn, retry = null) {
  const id = scenario.id;
  const runKey = runId();
  const runsDir = ensureRunsDir(repoRoot);
  const runDir = path.join(runsDir, runKey);
  fs.mkdirSync(runDir, { recursive: true });

  const createdFile = path.join(runDir, 'created.ndjson');

  // 预设排在建运行目录之前（#19 / ADR-0012）：它只要本次清单、runId 与账本路径，
  // 这三样到这里都确定了；失败时也不必浪费一次建目录。
  // 它走真 CLI、不经 shim——shim 是给被测 agent 用的，预设不是什么都要拦住。
  // 建出的 id 立刻进同一份账本，于是自动清场与 --clean 都管得到。
  // 加载与执行都归 runPreset：两者失败对编排层是同一件事——不进入会话、不清场。
  if (scenario.hasPreset) {
    try {
      await runPreset({ scenarioDir: scenario.dir, dida: realDida(), projects, createdFile });
    } catch (error) {
      // 失败时**不清场**：账本留在 runDir，--clean <runId> 读得到、删得掉已建的任务。
      // 也不建运行目录、不开会话——没有可判的事实，报一份只含判定与预设错误的报告。
      const manifest = {
        run: runKey,
        scenario: id,
        // 报告标题行按 kind 分区（探针 / scenario）：少了它，一条带预设的探针
        // 失败时会渲染成 `# scenario …`（README「报告标题行标明身份」）。
        kind: scenario.kind,
        skill: { source: options.skillPath },
        assertion: { status: 'preset-failed', detail: error.message, results: [] },
        created: readCreated(createdFile),
        calls: {},
        session: {},
        testProjects: projects,
        ...(retry ? { retry } : {}),
      };
      writeManifest(runDir, manifest);
      writeReport(runDir, manifest);
      return { run: runKey, runDir, sandbox: null, manifest, session: { exitCode: 1, timedOut: false }, createdFile };
    }
  }

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
  const argv = buildSessionArgv({
    prompt: scenario.prompt,
    agentsPath: sandbox.agentsPath,
  });

  const session = await runOneSession({
    argv, sandbox, callLogPath, createdFile, transcriptPath,
  });

  const events = parseTranscript(transcriptPath);
  const summary = summarizeTranscript(events);
  const git = gitState(repoRoot);
  const sourceEnv = sandbox.anthropicEnv;
  const created = readCreated(createdFile);
  const calls = fs.existsSync(callLogPath) ? parseCallLog(fs.readFileSync(callLogPath, 'utf8')) : [];

  const sessionInfo = {
    exitCode: session.exitCode,
    timedOut: session.timedOut,
    turns: summary.turns,
    costUsd: summary.costUsd,
  };

  // 两条路径共享前三步（ADR-0015）：会话门 → 可信度检查 → 取快照。**岔路在快照之后**——
  // 探针拿 sample 当结论就结束，scenario 拿它继续跑结局断言。分岔只发生在这一处
  // 「选哪个消费者」上，不散在流水线内部：下游的 manifest、报告与清场都只看结论。
  //
  // 快照传的是闭包，不是取好的结果：会话没正常结束或可信度检查不过时，
  // takeSample 根本不会调它，那次清单枚举就省掉了。清场在这之后才跑，
  // 「早于清场」由这里的位置保证。
  const completed = sessionCompleted(session);
  const statePath = path.join(runDir, 'state.json');
  const credibility = credibilityOf({
    calls,
    toolCalls: summary.toolCalls,
    events,
    // 运行目录 shim/ 下的 dida.cmd 也是 shim 的壳，写全名调它有日志，不是绕过。
    shimDir: sandbox.binDir,
  });
  const sample = takeSample({
    completed,
    crossCheck: credibility,
    // 取快照要枚举清单一，那一步失败不能带走整次运行——下面的 manifest 与清场
    // 必须照常执行，否则任务建在真实清单里却没人删。takeState 把失败折成 status。
    takeSnapshot: () => takeState({
      statePath,
      build: () => buildState({ dida: realDida(), created, projects }),
    }),
  });
  const verdict = scenario.kind === 'probe'
    // 探针不跑断言：共享段的结果就是它的结论（ADR-0015）。
    ? sample
    : await decideAssertion({
      sample,
      assertionFn,
      processFn,
      input: { created, calls, session: sessionInfo },
    });
  // 取到的事实以判定链实际取到的那份为准：断言读到的和报告写下的必须是同一份。
  // 快照要从 manifest 里剥掉——它已在 state.json 与 state 小节，再放一份等于
  // 把整份任务清单复制进 manifest。
  const { snapshot, ...verdictFields } = verdict;

  const manifest = {
    run: runKey,
    scenario: id,
    kind: scenario.kind,
    // 探针目录里的 assert.mjs 不执行，报告要据此留一行提示（ADR-0015）。
    unusedAssert: scenario.kind === 'probe' && scenario.hasAssert,
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
      // 按 reason 分开计数：四类归因不同（改 agent 命令 / 改 scenario / 改 guard），
      // 合成两桶会把「guard 没覆盖这条命令」藏起来（ADR-0005 2026-11-18 补充）。
      rejectedReasons: countRejectedReasons(calls),
      crossCheck: credibility,
    },
    created,
    // status 三态：not-taken（判定链在前一面就停了，没取）/ failed（取了但失败）/
    // ok（取到了）。count 为 null 表示「没有可数的事实」——前两种都落 null，与「取到了、0 条」区分开。
    state: {
      path: statePath,
      status: snapshot.status,
      count: snapshot.status === 'ok' ? snapshot.state.length : null,
      error: snapshot.error,
    },
    // 判定结论（scenario）或取样结论（探针）。快照本身不在这里重复一遍：
    // 它的内容已在 state.json 与 state 小节，塞进来会让 manifest 大出一份清单内容的副本。
    assertion: verdictFields,
    testProjects: projects,
    callerMarker: sandbox.callerMarker,
    // 重试的说明（#9）：它不参与判定，只是让报告说得出「这是第 2 次、首次是什么」。
    ...(retry ? { retry } : {}),
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

// 跑前清场：找到同一条用例**最近一次**未清场的 run（问题 3）。
// 探针不清场是设计（ADR-0015），代价是同一条用例重跑时上一次的任务还在清单里——
// agent 看到同名任务就不再新建，取样直接失真。所以开跑前按上一次的账本清一遍。
//
// 只认最近的那条，不回头找更早的：更早的现场可能已被人看过、留作证据。
// 最近那条已经清过场就什么都不做。
//
// 「清过没有」要看 `cleanupAfter`，不是 `cleanup`：后者是运行当时的结论，
// 会一直写着 deferred（收尾不覆盖它）。只看 cleanup 会让人每跑一次都重清一遍。
export function previousRunOf(repoRoot, id) {
  const runsDir = path.join(repoRoot, 'runs');
  if (!fs.existsSync(runsDir)) return null;

  const candidates = [];
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runsDir, entry.name);
    const manifestPath = path.join(runDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    if (manifest.scenario !== id) continue;
    candidates.push({ runDir, manifest, name: entry.name });
  }
  if (candidates.length === 0) return null;

  // runId 是 ISO 时间戳打头，按名倒序即按时间倒序。
  candidates.sort((a, b) => b.name.localeCompare(a.name));
  const latest = candidates[0];
  // 预设失败的 run 没有 cleanup 字段（它没走到清场那一步），但它建的预设任务
  // 确实还留在清单里，同样会让下一条用例的 agent 看到同名任务不再新建。
  // 账本按 runId 隔离，用 finishRun 收它不会碰别的 run。
  // 一条都没建出来时不必收：清它只会写下空的 cleanupAfter，白跑一次枚举。
  const presetLeftover = latest.manifest.assertion?.status === 'preset-failed'
    && readCreated(path.join(latest.runDir, 'created.ndjson')).length > 0;
  const leftBehind = latest.manifest.cleanup?.deferred || presetLeftover;
  if (!leftBehind) return null;
  if (latest.manifest.cleanupAfter) return null;
  return { runDir: latest.runDir, scenario: latest.manifest.scenario, manifest: latest.manifest };
}

export function writeManifest(runDir, manifest) {
  fs.writeFileSync(path.join(runDir, 'manifest.json'), safeStringify(manifest));
}

// 事后收尾：只按账本删任务，并把**收尾自己的结果**记进 manifest。
//
// 三条约束（缺一不可）：
// 1. **不重写 report.md**——它是那次运行的产物，`--clean` 是事后的动作。
//    之前这里会 writeReport，探针的「未清场」于是被改写成「按账本删除 1 条」，
//    读报告的人会以为探针自己清了场。
// 2. **不覆盖 `cleanup`**——那是运行当时的结论（例如 `deferred: true` 表示没清场）。
//    覆盖它等于篡改历史：事后没人能看出那次到底留没留现场。
// 3. 收尾结果另记在 `cleanupAfter`，与运行时的事实各归各位。
export function finishRun({ runDir, projects, dida }) {
  const createdFile = path.join(runDir, 'created.ndjson');
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : {};
  const cleanup = cleanRun({ dida, projects: manifest.testProjects ?? projects, createdFile });
  writeManifest(runDir, { ...manifest, cleanupAfter: cleanup });
  return cleanup;
}

function writeReport(runDir, manifest) {
  fs.writeFileSync(path.join(runDir, 'report.md'), `${renderReport(manifest)}\n`);
}

// 用例配置错误也要留下报告：AC 要求报告里能读到原因，而不只是 stderr 一行。
// 不建运行目录、不开会话，只落一份最小 manifest 与报告。
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

// 重试循环（#9）。抽出来是为了让「跑几次、第二次带什么 retry 说明」可测：
// 住在 main() 里时只能靠真跑一条 scenario 来验，而「只在 incomplete 时跑第二遍」
// 恰恰是最难靠运气撞到的分支。
// 每次尝试是一条完整的新运行（新 runId、新账本、新会话），第二次带着首次的
// 结论与 run id，好让报告与控制台说得出「这是第 2 次，第一次是什么」。
export async function runWithRetry({ kind, attempt }) {
  const attempts = [];
  let outcome = null;
  while (attempts.length < MAX_ATTEMPTS) {
    const retry = attempts.length === 0 ? null : {
      attempt: attempts.length + 1,
      previousRun: outcome.run,
      previousStatus: outcome.status,
    };
    outcome = await attempt(retry);
    // 每次尝试的 run/defer 都留下：重试会留下两批现场（首次 incomplete 不清场、
    // 重试那次若通过会自动清场），按最终那条收会让首次的现场从清单里消失。
    attempts.push({ status: outcome.status, run: outcome.run, defer: outcome.defer });
    if (!shouldRetry({ status: outcome.status, kind })) break;
  }
  return { ...outcome, attempts };
}

// 一次完整尝试：跑前清场 → 预设 → 会话 → 判定 → 清场 → 落 manifest/report → 控制台。
// 抽成函数是为了重试（#9）：重试是**再跑一次完整尝试**（新 runId、新账本、新会话），
// 不是接着上一次的现场往下走。`retry` 只带给报告与控制台的说明，不参与判定。
async function attemptScenario({ id, scenario, options, projects, assertionFn, processFn, retry }) {
  // 跑前清场（问题 3）：上一次这条用例没清场的话，它建的任务还留在清单里，
  // agent 看到同名任务就不再新建，取样直接失真。按上一次的账本先清一遍。
  // 只清同 id 的最近一条——别的用例的现场不归这次管。
  const previous = previousRunOf(repoRoot, id);
  if (previous) {
    try {
      const stale = finishRun({ runDir: previous.runDir, projects, dida: realDida() });
      console.log(`  cleanup 上一次运行 ${path.basename(previous.runDir)}：删掉 ${stale.deleted.length} 条残留任务`);
      if (hasCleanupProblem(stale)) console.error('    上一次的收尾没干净，本次取样可能受影响');
    } catch (error) {
      console.error(`    上一次运行 ${path.basename(previous.runDir)} 的收尾失败：${error.message}`);
    }
  }

  const { run, runDir, sandbox, manifest, session, createdFile } = await runOne(
    options, scenario, projects, assertionFn, processFn, retry,
  );
  const completed = sessionCompleted(session);

  // 预设失败：不开会话、不清场。账本与报告已由 runOne 落盘，--clean 能收尾。
  // 进不了会话的运行没有判定可给，直接报到汇总里让操作者收。
  if (manifest.assertion.status === 'preset-failed') {
    console.error(`PRESET FAILED ${id}  run=${run}`);
    console.error(`  ${manifest.assertion.detail}`);
    console.error(`  created=${manifest.created.length} 条（账本保留，用 --clean ${run} 收尾）`);
    console.error(`  run dir=${path.relative(repoRoot, runDir)}`);
    // 预设失败时 runOne 已按 defer 的口径落了 cleanup（没有 cleanup 字段），
    // 账本里建出的任务要人收，所以它进保留清单。
    return { run, status: manifest.assertion.status, defer: true, ok: false };
  }

  // 只有 PASSED 才清场（ADR-0014）；探针则永不清场（ADR-0015）。
  const defer = cleanupGate({
    status: manifest.assertion.status,
    hold: options.hold,
    kind: scenario.kind,
  });
  // 运行目录保留与清场是两件事：--keep-sandbox 只留目录，照常清场（README 参数表）。
  const retained = defer || options.keepSandbox;

  // 先把会话事实落盘，再动清单：清场读账本出错时，manifest 与 report 必须已经在了。
  writeManifest(runDir, { ...manifest, cleanup: null, sandboxRetained: retained });

  let cleanup;
  try {
    cleanup = defer
      ? emptyCleanup({ deferred: true })
      : cleanRun({ dida: realDida(), projects, createdFile });
  } catch (error) {
    cleanup = emptyCleanup({ error: error.message });
  }
  const finalManifest = { ...manifest, cleanup, sandboxRetained: retained };
  writeManifest(runDir, finalManifest);
  writeReport(runDir, finalManifest);
  // 删除失败要让后面三处都说实话：manifest 的 sandboxRetained、报告的「运行目录已删除」、
  // 控制台的 (removed)。吞掉异常却仍报 removed，读报告的人会以为盘上没有残留。
  let deleteError = null;
  if (!retained) {
    try {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    } catch (error) {
      deleteError = error.code ?? error.message;
      console.error(`    运行目录删除失败（${deleteError}）：${sandbox.root}`);
      writeManifest(runDir, { ...finalManifest, sandboxRetained: true, sandboxDeleteError: deleteError });
    }
  }

  // 清场失败只记 log 不中断：每条 scenario 的账本按 runId 隔离，删不掉自己的那几条
  // 不会影响下一条的判断。退出码仍非零，让人知道有现场要收。
  const cleanupProblem = hasCleanupProblem(cleanup);
  // 退出码只反映「这次运行能不能用」（ADR-0015）：
  //   scenario：除 passed 外都要非零——failed 是 skill 有缺陷，broken 是用例有缺陷，
  //            invalid 是结果不可用，三者都要人看一眼。
  //   探针：只有 sampled 是 0。incomplete / invalid 说明这份样本不能用，
  //        1 就是在告诉脚本「别拿它写断言」。
  const ok = manifest.assertion.status === (scenario.kind === 'probe' ? 'sampled' : 'passed');

  const verdict = scenario.kind === 'probe'
    ? { sampled: 'SAMPLED', incomplete: 'INCOMPLETE', invalid: 'INVALID' }[manifest.assertion.status]
    : {
      passed: 'PASSED',
      incomplete: 'INCOMPLETE',
      failed: 'FAILED',
      broken: 'BROKEN',
      invalid: 'INVALID',
    }[manifest.assertion.status];
  console.log(`${verdict} ${id}  run=${run}`);
  if (retry) console.log(`  重试：第 ${retry.attempt} 次，首次 ${retry.previousStatus}（run=${retry.previousRun}）`);
  console.log(`  skill sha256=${manifest.skill.sha256.slice(0, 16)} files=${manifest.skill.files} git=${manifest.skill.git.rev?.slice(0, 12)}${manifest.skill.git.dirty ? ' (dirty)' : ''}`);
  console.log(`  model alias=${manifest.model.requested_alias} provider=${manifest.model.provider}（别名不等于实际执行模型，真实映射见 manifest.model.alias_mapping）`);
  console.log(`  sandbox=${sandbox.root}${retained || deleteError ? ' (retained)' : ' (removed)'}`);
  console.log(`  transcript=${path.relative(repoRoot, manifest.transcript.path)} events=${manifest.transcript.events} toolCalls=${manifest.transcript.toolCalls}`);
  console.log(`  calls=${path.relative(repoRoot, manifest.calls.path)} total=${manifest.calls.total} rejected=${manifest.calls.rejected} outOfBounds=${manifest.calls.outOfBounds}`);
  console.log(`  created=${manifest.created.length} 条${manifest.created.length ? '：' + manifest.created.map((e) => e.id).join('、') : ''}`);
  console.log(stateLine(manifest));
  for (const line of verdictLines(manifest.assertion)) console.error(line);
  reportCleanup(cleanup, run);
  console.log(`  caller marker=${manifest.callerMarker}`);
  console.log(`  run dir=${path.relative(repoRoot, runDir)}`);
  if (!completed) console.log(`  session exit=${session.exitCode} timedOut=${session.timedOut}`);

  // 除了判定结论，清场问题与会话没跑完也要算进这一条的 ok：
  // 它们是「这次运行能不能用」的一部分，不能因为结论写着 passed 就报绿。
  return {
    run,
    status: manifest.assertion.status,
    defer,
    ok: ok && completed && !cleanupProblem && !deleteError,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`用法：
  node harness/run.mjs [--scenario <id>] [--skill-path <dir>] [--settings <file>] [--keep-sandbox] [--hold]
  node harness/run.mjs --clean <runId>

  --scenario <id>     只跑这一条（默认跑全部正式用例；id 也可命中 probes/ 里的探针）
  --skill-path <dir>  复制进运行目录的 skill 目录（默认 skills/dida-cli）
  --settings <file>   取 ANTHROPIC_* 键的来源（默认 ~/.claude/settings.json）
  --keep-sandbox      成功时也保留运行目录（不影响清场）
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
    const cleanup = finishRun({ runDir, projects: manifest.testProjects ?? projects, dida: realDida() });
    reportCleanup(cleanup);
    if (hasCleanupProblem(cleanup)) process.exitCode = 1;
    return;
  }

  const ids = options.scenario ? [options.scenario] : listScenarios(repoRoot);
  if (ids.length === 0) {
    console.error('no scenarios found');
    // probes/ 里有东西恰恰解释了「为什么一条都没跑」：它们还没晋升。
    if (!options.scenario) {
      for (const line of probesLeftoverLines(listProbes(repoRoot))) console.error(line);
    }
    process.exitCode = 1;
    return;
  }

  // 清单只收真正开过会话、有现场的 run：NOT FOUND 与 MISCONFIGURED 在开会话之前
  // 就退出了，没有任务也没有运行目录，列进来只会让人去找一个不存在的现场。
  const retainedRuns = [];
  const runs = [];
  for (const id of ids) {
    // 缺 assert.mjs 不开会话：两个目录（scenarios/ 与 probes/）的区分就是有没有断言，
    // 跳过会让漏写的用例静默退出回归网、退出码仍是 0。这是用例配置错误，不是断言未通过。
    // loadScenario 单独拿出来：--scenario 写错 id 要报「找不到」，不能混成缺断言。
    let scenario;
    try {
      scenario = loadScenario(repoRoot, id);
    } catch (error) {
      console.error(`NOT FOUND ${id}  ${error.message}`);
      runs.push({ scenario: id, status: 'not-found', attempts: [{ status: 'not-found' }] });
      continue;
    }
    let assertionFn;
    let processFn = null;
    let loadError = null;
    try {
      ({ assertionFn, processFn } = await loadScenarioAssertions(scenario));
    } catch (error) {
      loadError = error;
    }
    if (loadError || !assertionFn) {
      const status = loadError ? 'broken' : 'missing';
      const detail = loadError
        ? `断言模块加载失败：${loadError.message}`
        : `缺 ${path.join(scenario.dir, 'assert.mjs')}`;
      const { runKey, runDir } = writeUnusableRun(repoRoot, id, {
        skillPath: options.skillPath,
        status,
        detail,
      });
      console.error(`MISCONFIGURED ${id}  ${detail}（报告 ${path.relative(repoRoot, runDir)}，run=${runKey}）`);
      // 用例配置错误不重试：重跑一次不会让它变绿（shouldRetry 会拦，这里也不进重试循环）。
      runs.push({ scenario: id, status, attempts: [{ status }] });
      continue;
    }

    const notice = probeAssertNotice(scenario);
    if (notice) console.log(notice);

    // 重试（#9）：只重试 incomplete——那是运行器自己没跑完。其余结论都是判定，
    // 要停下看原因。每次尝试都是一条完整的新运行（新 runId、新账本、新会话），
    // 所以重试前那一步「跑前清场」会照常把上一次的残留收掉。
    const outcome = await runWithRetry({
      kind: scenario.kind,
      attempt: (retry) => {
        if (retry) console.log(`RETRY ${id}  首次 ${retry.previousStatus}（run=${retry.previousRun}），再跑一次`);
        return attemptScenario({ id, scenario, options, projects, assertionFn, processFn, retry });
      },
    });
    const { attempts } = outcome;
    // 保留清单按每次尝试收，不按最终那条：首次 incomplete 的现场与重试那次的现场
    // 是两批任务、两个 runId，都得让人能追溯（ADR-0014）。
    for (const attempt of attempts) {
      if (attempt.defer) retainedRuns.push({ run: attempt.run, scenario: id, status: attempt.status });
    }
    // 判定结论原样入汇总，`ok` 另记「这次运行算不算成功」——把清场问题折成
    // failed 会让一次通过的判定在汇总里消失（口径见 lib/batch.mjs）。
    runs.push({ scenario: id, status: outcome.status, ok: outcome.ok, attempts });
  }

  // 批跑汇总（ADR-0014）：失败即留现场，跑十条挂六条就是六批任务。
  // 没有这份清单，人下次打开客户端无从追溯该收哪几条。
  for (const line of retainedSummaryLines(retainedRuns)) console.log(line);
  // 结论分布（#9）：只有全量运行才给。单跑一条时它的结论已经打在那一行上，
  // 再补一句「批跑汇总：1 条（passed 1）」只是噪声。
  const summary = summarizeBatch(runs);
  if (!options.scenario) for (const line of batchSummaryLines(summary)) console.log(line);
  // 流程提醒只在全量运行时给：单跑一条用例时，probes/ 里待着的探针本来就该在，
  // 别的用例的来源状态也不该在这次运行的输出里插话。两条提醒同一个门控。
  if (!options.scenario) {
    for (const line of probesLeftoverLines(listProbes(repoRoot))) console.log(line);
  }
  // 退出码由汇总统一给（#9）：一条条累加 failures 会在重试时把两次尝试算成两次失败。
  if (summary.exitCode !== 0) process.exitCode = 1;
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
