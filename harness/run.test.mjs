import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cleanupGate,
  credibilityOf,
  deferredCleanupLine,
  finishRun,
  hasCleanupProblem,
  previousRunOf,
  probeAssertNotice,
  sessionEnvOf,
  probesLeftoverLines,
  retainedSummaryLines,
  stateLine,
  takeState,
  verdictLines,
  withPrependedPath,
  writeManifest,
  writeUnusableRun,
} from './run.mjs';

function tmpRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 快照只做一件事：build 一次、成功就落盘。**要不要 build** 由判定链决定
// （assertion.mjs 的 decideAssertion），这里不再自己判前置门与可信度——
// 两处各判一次就会出现「这一面说没取、那一面说取了」的分叉。

test('会话正常结束时取快照并落盘', (t) => {
  const dir = tmpRepo(t);
  const statePath = path.join(dir, 'state.json');

  const out = takeState({ statePath, build: () => [{ id: 'a' }] });

  assert.equal(out.status, 'ok');
  assert.deepEqual(out.state, [{ id: 'a' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), [{ id: 'a' }]);
});

test('取快照失败时不写 state.json，也不抛——manifest 与清场还得照常跑', (t) => {
  const dir = tmpRepo(t);
  const statePath = path.join(dir, 'state.json');

  const out = takeState({
    statePath,
    build: () => { throw new Error('网络抖动'); },
  });

  assert.equal(out.status, 'failed');
  assert.equal(out.error, '网络抖动');
  assert.equal(fs.existsSync(statePath), false);
});

// 写盘也可能失败（磁盘满、权限）。它若抛出，判定链就断了：manifest 落不下、清场不跑，
// 任务留在真实清单里没人删。所以与取数失败同一个出口。
test('落盘失败同样折成 failed，不抛', (t) => {
  const dir = tmpRepo(t);
  // 拿目录当文件名：writeFileSync 必然抛 EISDIR
  const statePath = path.join(dir, 'state.json');
  fs.mkdirSync(statePath);

  const out = takeState({ statePath, build: () => [{ id: 'a' }] });

  assert.equal(out.status, 'failed');
  assert.ok(out.error, '错误消息要留下，不能靠空串判失败');
});

test('控制台的 state 行三种情形各说各的：「没取」不冒充「取失败」', () => {
  // 没取有两种来路，控制台上共用一句——两者的处置都是看判定那一行，而那里已经写明原因。
  const notTaken = stateLine({ state: { path: 'x', status: 'not-taken', count: null, error: null } });
  const failed = stateLine({ state: { path: 'x', status: 'failed', count: null, error: '网络抖动' } });
  const ok = stateLine({ state: { path: 'x', status: 'ok', count: 2, error: null } });

  assert.match(notTaken, /未取/);
  assert.match(notTaken, /判定链/);
  assert.match(failed, /未落盘/);
  assert.match(failed, /网络抖动/);
  assert.doesNotMatch(failed, /判定链/);
  assert.match(ok, /2 条/);
  assert.doesNotMatch(ok, /未/);
});

function cleanupFixture(overrides = {}) {
  return { deleted: [], failed: [], remaining: [], mismatched: [], ...overrides };
}

test('清场全部成功时不算问题', () => {
  assert.equal(hasCleanupProblem(cleanupFixture({ deleted: ['a'] })), false);
});

test('账本与实况的清单不一致但已按实况删掉，不算问题（ADR-0010 定性为合法）', () => {
  const cleanup = cleanupFixture({
    deleted: ['a'],
    mismatched: [{ id: 'a', recordedAt: 'p1', actual: 'p2' }],
  });
  assert.equal(hasCleanupProblem(cleanup), false);
});

test('删完仍在清单里算问题', () => {
  assert.equal(hasCleanupProblem(cleanupFixture({ remaining: ['a'] })), true);
});

test('删除失败算问题', () => {
  assert.equal(hasCleanupProblem(cleanupFixture({ failed: [{ id: 'a' }] })), true);
});

test('清场读账本出错算问题', () => {
  assert.equal(hasCleanupProblem(cleanupFixture({ error: '账本损坏' })), true);
});

test('缺断言时也落一份报告，报告里写明是「缺断言」而不是「断言未通过」', (t) => {
  const root = tmpRepo(t);
  const { runDir } = writeUnusableRun(root, 's1', {
    skillPath: 'skills/dida-cli',
    status: 'missing',
    detail: '缺 skill-tests/scenarios/s1/assert.mjs',
  });

  const report = fs.readFileSync(path.join(runDir, 'report.md'), 'utf8');
  assert.match(report, /缺断言/);
  assert.match(report, /用例配置错误/);
  assert.doesNotMatch(report, /结局断言 未通过/);
  // 没开会话，报告里不该出现会话/模型/清场小节——那会让读者以为跑过。
  assert.doesNotMatch(report, /## 会话/);
  assert.doesNotMatch(report, /## 模型/);
  assert.doesNotMatch(report, /跑了一次真实会话/);

  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.assertion.status, 'missing');
  assert.equal(manifest.scenario, 's1');
});

test('断言模块加载失败同样落报告，与缺断言分开写', (t) => {
  const root = tmpRepo(t);
  const { runDir } = writeUnusableRun(root, 's1', {
    skillPath: 'skills/dida-cli',
    status: 'broken',
    detail: 'assert.mjs 没有默认导出的函数',
  });

  const report = fs.readFileSync(path.join(runDir, 'report.md'), 'utf8');
  assert.match(report, /用例配置错误/);
  assert.match(report, /assert\.mjs 没有默认导出的函数/);
  assert.doesNotMatch(report, /缺断言/);
});

test('用例没跑起来时不建运行目录、不开会话：manifest 里没有会话记录', (t) => {
  const root = tmpRepo(t);
  const { runDir } = writeUnusableRun(root, 's1', { skillPath: 'skills/dida-cli', status: 'missing', detail: 'x' });
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.created.length, 0);
  assert.deepEqual(manifest.session, {});
});

test('manifest 里的循环引用不能让写文件抛错——抛了清场就跑不到', (t) => {
  const dir = tmpRepo(t);
  const circular = {};
  circular.self = circular;

  writeManifest(dir, { assertion: { results: [{ ok: false, name: 'x', expected: circular, actual: 'y' }] } });

  const text = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  assert.match(text, /循环引用/);
  assert.doesNotThrow(() => JSON.parse(text), '落盘的仍是合法 JSON');
});

test('manifest 里的 BigInt 折成字符串，不抛错', (t) => {
  const dir = tmpRepo(t);
  assert.doesNotThrow(() => writeManifest(dir, { assertion: { results: [{ ok: false, expected: 1n }] } }));
  assert.match(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), /1n/);
});

test('两个字段指向同一个对象不算环，值要原样留下', (t) => {
  const dir = tmpRepo(t);
  const shared = { kind: 'TEXT' };
  writeManifest(dir, { assertion: { results: [{ ok: false, expected: shared, actual: shared }] } });

  const text = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  assert.doesNotMatch(text, /循环引用/, '共享引用是正常数据');
  assert.match(text, /"kind": "TEXT"/);
});

// 接线测试：runOne 不导出，这层覆盖「crossCheck → 三态 → detail」的组装，
// 免得 run.mjs 里接错时单测仍全绿。

test('credibilityOf：轨迹里的调用在日志里都有对应时判 consistent', () => {
  const out = credibilityOf({
    calls: [{ argv: ['task', 'get'] }, { argv: ['project', 'list'] }],
    toolCalls: [
      { name: 'PowerShell', input: { command: 'dida task get' } },
      { name: 'PowerShell', input: { command: 'dida project list' } },
    ],
    events: [{ type: 'assistant' }],
  });
  assert.equal(out.status, 'consistent');
  assert.match(out.detail, /都有对应/);
});

test('credibilityOf：有一次 dida 调用没进日志时判 inconsistent，detail 点出是哪次', () => {
  const out = credibilityOf({
    calls: [{ argv: ['task', 'get'] }],
    toolCalls: [
      { name: 'PowerShell', input: { command: 'dida task get' } },
      { name: 'PowerShell', input: { command: '& "C:\\bin\\dida.cmd" task create --title z' } },
    ],
    events: [{ type: 'assistant' }],
  });
  assert.equal(out.status, 'inconsistent');
  assert.match(out.detail, /task create --title z/);
  assert.deepEqual(out.unmatched.map((c) => c.argv), [['task', 'create', '--title', 'z']]);
});

test('credibilityOf：非 dida 的 PowerShell 命令不会被误判为绕过', () => {
  const out = credibilityOf({
    calls: [{ argv: ['task', 'get'] }],
    toolCalls: [
      { name: 'PowerShell', input: { command: 'Get-ChildItem -Force' } },
      { name: 'PowerShell', input: { command: 'dida task get' } },
    ],
    events: [{ type: 'assistant' }],
  });
  assert.equal(out.status, 'consistent');
});

test('credibilityOf：轨迹一条可解析事件都没有时判 indeterminate，不是 consistent', () => {
  const out = credibilityOf({
    calls: [],
    toolCalls: [],
    events: [{ type: 'unparseable' }, { type: 'unparseable' }],
  });
  assert.equal(out.status, 'indeterminate');
});

test('credibilityOf：轨迹正常但没调 PowerShell 时是 consistent', () => {
  const out = credibilityOf({
    calls: [],
    toolCalls: [{ name: 'Read' }],
    events: [{ type: 'assistant' }],
  });
  assert.equal(out.status, 'consistent');
});

test('credibilityOf：轨迹读不出时 detail 不报未观测到的条数', () => {
  const out = credibilityOf({
    calls: [],
    toolCalls: [],
    events: [{ type: 'unparseable' }, { type: 'unparseable' }],
  });
  assert.equal(out.status, 'indeterminate');
  assert.doesNotMatch(out.detail, /0 条 dida 调用/);
  assert.match(out.detail, /2 条事件/);
});

// 控制台侧的一次运行一结论（ADR-0014，报告侧同口径见 verdict.test.mjs）。
// 断言整段输出而不是只查某个词：回潮最可能的样子是有人把后面那面又加回来。
test('可信度失败时控制台只打第一面，不并排结局断言结论', () => {
  const lines = verdictLines({
    status: 'invalid',
    cause: 'cross-check',
    detail: '调用日志与轨迹对不上：3 条 dida 调用 / 4 次 PowerShell',
    results: [{ ok: false, name: '可信度检查', expected: 'x', actual: '3 条 dida 调用 / 4 次 PowerShell' }],
    // 旧 manifest 里残留的字段：控制台也不该翻出来（--clean 会用当前代码重出报告）
    evaluated: { status: 'failed', results: [{ ok: false, name: '父任务应为 TEXT', expected: 'TEXT', actual: 'CHECKLIST' }] },
  });
  const text = lines.join('\n');
  assert.match(text, /结果不可信 可信度检查/);
  assert.match(text, /3 条 dida 调用 \/ 4 次 PowerShell/);
  assert.doesNotMatch(text, /父任务应为 TEXT/, '后面各面的结论不该出现在控制台');
  assert.doesNotMatch(text, /断言未通过/, '可信度失败时没有断言这一面');
  assert.equal(lines.length, 1, '只有第一面那一条失败项');
});

test('结局断言失败时控制台照旧打「断言未通过」', () => {
  const text = verdictLines({
    status: 'failed',
    results: [{ ok: false, name: '父任务应为 TEXT', expected: 'TEXT', actual: 'CHECKLIST' }],
  }).join('\n');
  assert.match(text, /断言未通过 父任务应为 TEXT/);
  assert.match(text, /期望 TEXT/);
});

// 清场门控（ADR-0014）：只有 PASSED 才清场。这张表是判定结果与清场动作的唯一映射，
// 逐状态钉住——旧门控是「会话没正常结束才不清场」，断言失败照清，
// 而断言失败的时刻恰恰最需要对着任务清单看它为什么失败。
test('只有 passed 才清场', () => {
  assert.equal(cleanupGate({ status: 'passed', hold: false }), false);
});

test('incomplete / invalid / failed / broken 一律保留现场', () => {
  for (const status of ['incomplete', 'invalid', 'failed', 'broken']) {
    assert.equal(cleanupGate({ status, hold: false }), true, `${status} 不该清场`);
  }
});

test('--hold 让通过的运行也保留现场', () => {
  assert.equal(cleanupGate({ status: 'passed', hold: true }), true);
});

test('--keep-sandbox 不阻止清场：它只管运行目录，清场看的是 --hold 与判定结论', () => {
  // README 的参数表把 --keep-sandbox 定义为「成功时也保留运行目录」。
  // 把它并进门控会让 PASSED + --keep-sandbox 连任务一起留下，
  // 与验收标准「只有 PASSED 执行清场」相反。
  assert.equal(cleanupGate({ status: 'passed', hold: false }), false);
});

// 探针永不清场（ADR-0015）：它的全部价值就是现场——任务、运行目录、state.json
// 都要留着供人打开客户端对着写断言。这条不能靠「探针结论不是 passed」这种
// 巧合成立：将来探针若多一个新结论词，清场就会悄悄漏进来。
test('探针无论结论如何都不清场', () => {
  for (const status of ['sampled', 'incomplete', 'invalid']) {
    assert.equal(cleanupGate({ status, hold: false, kind: 'probe' }), true, `探针 ${status} 不该清场`);
  }
});

test('保留现场时控制台写「现场已保留，用 --clean <runId> 收尾」', () => {
  const line = deferredCleanupLine('2026-11-16T09-00-00-000Z-ab12cd');
  assert.match(line, /现场已保留/);
  assert.match(line, /--clean 2026-11-16T09-00-00-000Z-ab12cd/);
  assert.doesNotMatch(deferredCleanupLine(undefined), /undefined/, '没有 run id 时不写一个假的');
});

test('批跑汇总列出本次所有保留现场的 run——失败即留现场，没有清单无从追溯', () => {
  const lines = retainedSummaryLines([
    { run: 'r1', scenario: 's1', status: 'incomplete' },
    { run: 'r2', scenario: 's2', status: 'failed' },
    { run: 'r4', scenario: 's4', status: 'invalid' },
  ]);
  const text = lines.join('\n');
  assert.match(text, /3 条现场已保留/);
  assert.match(text, /r1/);
  assert.match(text, /s1/);
  assert.match(text, /r2/);
  assert.match(text, /s2/);
  assert.match(text, /r4/);
  assert.match(text, /s4/);
  assert.match(text, /--clean <runId>/);
});

test('通过的运行被 --hold 留下时也进汇总理清单——现场确实存在', () => {
  const text = retainedSummaryLines([{ run: 'r9', scenario: 's9', status: 'passed' }]).join('\n');
  assert.match(text, /1 条现场已保留/);
  assert.match(text, /r9/);
});

test('没有保留现场时也不写清单', () => {
  assert.deepEqual(retainedSummaryLines([]), []);
});

// #36：Windows 继承来的键名大小写不定（通常是 `Path`）。写一个固定的 `PATH` 会在对象里
// 造出两个同义键，spawn 时后者胜出、继承的 PATH 整个丢掉——运行目录里裸 node 就找不到了。
test('PATH 前置复用已有的那个键，不新造同名不同大小写的键', () => {
  const inherited = 'C:\\Windows\\System32;C:\\Other';
  for (const key of ['Path', 'PATH', 'path']) {
    const env = withPrependedPath({ [key]: inherited }, 'C:\\sandbox\\bin');
    const pathKeys = Object.keys(env).filter((name) => name.toUpperCase() === 'PATH');
    assert.deepEqual(pathKeys, [key], `键名 ${key} 下不该多出一个：${pathKeys.join(',')}`);
    assert.equal(env[key], `C:\\sandbox\\bin${path.delimiter}${inherited}`, '继承的 PATH 必须接在 binDir 后面');
  }
});

test('没有 path 类键时才新建 PATH', () => {
  const env = withPrependedPath({ HOME: '/home/x' }, '/sandbox/bin');
  assert.equal(env.PATH, `/sandbox/bin${path.delimiter}`);
});

test('前置不改动传入的对象', () => {
  const source = { Path: 'C:\\Windows' };
  withPrependedPath(source, 'C:\\bin');
  assert.deepEqual(source, { Path: 'C:\\Windows' });
});

// 空轨迹与全是垃圾行，指引相反：前者是 CLI 没吐出东西（重跑），
// 后者是解析器/harness 缺陷（重跑没用）。同归「无法判定」，但要说清是哪种（#18 移交的第 4 条）。
test('credibilityOf：空轨迹与全是垃圾行的 detail 指向不同的下一步', () => {
  const empty = credibilityOf({ calls: [], toolCalls: [], events: [] });
  const garbage = credibilityOf({
    calls: [],
    toolCalls: [],
    events: [{ type: 'unparseable', raw: 'x' }, { type: 'unparseable', raw: 'y' }],
  });
  assert.equal(empty.status, 'indeterminate');
  assert.equal(garbage.status, 'indeterminate');
  assert.match(empty.detail, /重跑/);
  assert.match(garbage.detail, /重跑没用/);
  assert.notEqual(empty.detail, garbage.detail);
});

// 运行目录 shim/ 里的 dida.cmd 是 shim 的壳：写全名调它有日志，不能判成绕过。
test('credibilityOf：运行目录 shim/ 下的全名调用算 shim，不算绕过', () => {
  const sandboxBin = 'C:\Temp\run-abc123\shim';
  const out = credibilityOf({
    calls: [{ argv: ['task', 'get'] }],
    toolCalls: [{ name: 'PowerShell', input: { command: `${sandboxBin}\dida.cmd task get` } }],
    events: [{ type: 'assistant' }],
    shimDir: sandboxBin,
  });
  assert.equal(out.status, 'consistent', JSON.stringify(out));
});

// 全量运行不碰 probes/（ADR-0015）：探针不计入回归网。但 probes/ 里有残留
// 说明流程没走完——「断言写好了却没搬走」会让回归网静默少一条。
test('probes/ 为空时不写提醒', () => {
  assert.deepEqual(probesLeftoverLines([]), []);
});

test('probes/ 非空时汇总末尾提醒清理', () => {
  const text = probesLeftoverLines(['checklist-desc-field', 'another-probe']).join('\n');
  assert.match(text, /2 条探针/);
  assert.match(text, /checklist-desc-field/);
  assert.match(text, /another-probe/);
  assert.match(text, /scenarios/);
});

test('提醒不冒充失败：它说的是流程没走完，不是哪条用例没通过', () => {
  const text = probesLeftoverLines(['p1']).join('\n');
  assert.doesNotMatch(text, /FAILED/);
  assert.doesNotMatch(text, /未通过/);
});

// 探针目录里的 assert.mjs 不执行（ADR-0012）。但静默忽略会让「写了断言却没结论」
// 变成一次无声的困惑——排查的人会先怀疑 harness。
test('探针里放了 assert.mjs 时给出提示，说明它未被使用', () => {
  const line = probeAssertNotice({ id: 'p1', kind: 'probe', dir: 'skill-tests/probes/p1', hasAssert: true });
  assert.match(line, /assert\.mjs/);
  assert.match(line, /未被使用/);
  assert.match(line, /scenarios/);
});

test('探针没有 assert.mjs 时不提示', () => {
  assert.equal(probeAssertNotice({ id: 'p1', kind: 'probe', dir: 'skill-tests/probes/p1', hasAssert: false }), null);
});

test('正式用例带了 assert.mjs 不触发探针提示', () => {
  assert.equal(probeAssertNotice({ id: 's1', dir: 'x', kind: 'scenario', hasAssert: true }), null);
});

// ─────────────────────────────────────────────────────────────────────────
// 事后收尾（问题 2）：--clean 是操作者的收尾动作，不是那次运行的产物。
// report.md 一旦落盘就是历史事实，收尾只能更新 manifest 里的记录。
// 之前的实现会按新 manifest 重画整份报告——探针的「未清场」于是变成
// 「按账本删除 1 条」，读报告的人会以为探针自己清了场。
// ─────────────────────────────────────────────────────────────────────────

test('收尾只更新 manifest，report.md 逐字不变', (t) => {
  const root = tmpRepo(t);
  const runDir = path.join(root, 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  const reportPath = path.join(runDir, 'report.md');
  const ORIGINAL = '# 探针 p1 · r1\n\n## 取样\n\n**已取样**\n';
  fs.writeFileSync(reportPath, ORIGINAL);
  fs.writeFileSync(path.join(runDir, 'created.ndjson'), '');
  writeManifest(runDir, { run: 'r1', scenario: 'p1', kind: 'probe', cleanup: { deferred: true } });

  const cleanup = finishRun({
    runDir,
    projects: [],
    dida: { run: () => ({ stdout: '[]', stderr: '', exitCode: 0 }) },
  });

  assert.equal(fs.readFileSync(reportPath, 'utf8'), ORIGINAL, '报告是那次运行的产物，收尾不该改它');
  assert.deepEqual(cleanup.deleted, []);
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  // 那次运行的事实原样保留：收尾不能改写「当时没清场」这个结论。
  assert.equal(manifest.cleanup.deferred, true, '运行时的 cleanup 是历史事实，收尾不该覆盖它');
  assert.equal(manifest.kind, 'probe', '其余字段原样保留');
  // 收尾自己的结果另记一处。
  assert.deepEqual(manifest.cleanupAfter, cleanup);
});

test('收尾记录清场结果供人查', (t) => {
  const root = tmpRepo(t);
  const runDir = path.join(root, 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'report.md'), '原始报告');
  fs.writeFileSync(
    path.join(runDir, 'created.ndjson'),
    `${JSON.stringify({ id: 'a', projectId: 'p1', title: 't' })}\n`,
  );
  writeManifest(runDir, { run: 'r1', scenario: 's1', kind: 'scenario' });

  const cleanup = finishRun({
    runDir,
    projects: ['p1'],
    dida: {
      run: (argv) => {
        if (argv[0] === 'task' && argv[1] === 'filter') {
          return { stdout: JSON.stringify([{ id: 'a' }]), stderr: '', exitCode: 0 };
        }
        if (argv[0] === 'task' && argv[1] === 'delete') return { stdout: '', stderr: '', exitCode: 0 };
        return { stdout: '[]', stderr: '', exitCode: 0 };
      },
    },
  });

  assert.deepEqual(cleanup.deleted, ['a']);
  assert.equal(fs.readFileSync(path.join(runDir, 'report.md'), 'utf8'), '原始报告');
});

// ─────────────────────────────────────────────────────────────────────────
// 跑前清场（问题 3）：探针不清场是设计，代价是同一条用例重跑时
// 上一次留下的任务还在清单里——agent 看到同名任务就不再新建，
// 取样直接失真（2026-11-17 实际发生过：created=0，agent 只是查了旧任务）。
//
// 所以跑某条用例之前，按该用例**上一次**的 run 账本清一遍。
// 只清同 id 的那一条，不碰别的用例的现场。
// ─────────────────────────────────────────────────────────────────────────

function writeRun(root, runKey, { scenario, kind = 'scenario', deferred = true }) {
  const runDir = path.join(root, 'runs', runKey);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    JSON.stringify({
      run: runKey, scenario, kind, testProjects: [],
      cleanup: deferred ? { deferred: true } : { deleted: [], failed: [], remaining: [], mismatched: [] },
    }),
  );
  fs.writeFileSync(path.join(runDir, 'report.md'), `报告 ${runKey}`);
  return runDir;
}

test('跑前清场找到同一条用例上一次的 run', (t) => {
  const root = tmpRepo(t);
  writeRun(root, '2026-11-17T01-00-00-000Z-aaaaaa', { scenario: 'p1' });
  writeRun(root, '2026-11-17T02-00-00-000Z-bbbbbb', { scenario: 'p1' });
  writeRun(root, '2026-11-17T03-00-00-000Z-cccccc', { scenario: 'other' });

  const found = previousRunOf(root, 'p1');
  assert.equal(path.basename(found.runDir), '2026-11-17T02-00-00-000Z-bbbbbb', '取时间最新的那一条');
  assert.equal(found.scenario, 'p1');
});

test('没有历史 run 时跑前清场什么都不做', (t) => {
  assert.equal(previousRunOf(tmpRepo(t), 'never-run'), null);
});

test('跑前清场不碰别的用例的 run', (t) => {
  const root = tmpRepo(t);
  writeRun(root, 'r-other', { scenario: 'other' });
  assert.equal(previousRunOf(root, 'p1'), null);
});

// 已清过场的 run 不该被再清一次：账本是唯一依据，但重复清场会报 deleted 数，
// 让人以为又删了东西。按 manifest 判它清没清过。
test('已经清过场的 run 不再进跑前清场', (t) => {
  const root = tmpRepo(t);
  writeRun(root, 'r-done', { scenario: 'p1', deferred: false });
  writeRun(root, 'r-pending', { scenario: 'p1', deferred: true });
  assert.equal(path.basename(previousRunOf(root, 'p1').runDir), 'r-pending');
});

test('同一条用例最近的 run 已清场时，不回头去清更早的那条', (t) => {
  const root = tmpRepo(t);
  writeRun(root, '2026-11-17T01-00-00-000Z-old', { scenario: 'p1', deferred: true });
  writeRun(root, '2026-11-17T02-00-00-000Z-new', { scenario: 'p1', deferred: false });
  assert.equal(previousRunOf(root, 'p1'), null, '只认最近的那条：更早的现场可能已被人看过、留作证据');
});

test('runs/ 不存在时跑前清场不报错', (t) => {
  assert.equal(previousRunOf(tmpRepo(t), 'p1'), null);
});

// 收尾之后 cleanup 仍是 deferred（历史事实），所以「清过没有」只能看 cleanupAfter。
// 只看 cleanup 会让每跑一次都重清一遍——同一批任务被反复报「删掉 N 条」。
test('收尾过的 run 不再被跑前清场选中，尽管 cleanup.deferred 仍为真', (t) => {
  const root = tmpRepo(t);
  const runDir = writeRun(root, '2026-11-17T01-00-00-000Z-done', { scenario: 'p1' });
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    JSON.stringify({ ...manifest, cleanupAfter: { deleted: [], failed: [], remaining: [], mismatched: [] } }),
  );

  assert.equal(previousRunOf(root, 'p1'), null);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')).cleanup.deferred,
    true,
    '运行时的结论不能被收尾抹掉',
  );
});

// 预设失败的 run 没走到清场那一步，manifest 里根本没有 cleanup 字段（#19）。
// 但它建出的预设任务还留在清单里，同样会让下一条用例的 agent 看到同名任务不再新建。
function writePresetFailedRun(root, runKey, { scenario, created = [] }) {
  const runDir = path.join(root, 'runs', runKey);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    JSON.stringify({
      run: runKey,
      scenario,
      kind: 'scenario',
      testProjects: [],
      assertion: { status: 'preset-failed', detail: '越界', results: [] },
    }),
  );
  if (created.length > 0) {
    fs.writeFileSync(
      path.join(runDir, 'created.ndjson'),
      created.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
    );
  }
  return runDir;
}

test('预设失败且建出了任务的 run 进跑前清场', (t) => {
  const root = tmpRepo(t);
  writePresetFailedRun(root, '2026-11-17T01-00-00-000Z-pf', {
    scenario: 'p1',
    created: [{ id: 'aaaa00000000000000000001', projectId: 'x', title: '前置', origin: 'preset' }],
  });
  const found = previousRunOf(root, 'p1');
  assert.ok(found, '预设建的任务还在清单里，下一次跑会被它污染');
  assert.equal(path.basename(found.runDir), '2026-11-17T01-00-00-000Z-pf');
});

test('预设失败但一条都没建出来的 run 不进跑前清场——清它只是白枚举一次', (t) => {
  const root = tmpRepo(t);
  writePresetFailedRun(root, '2026-11-17T01-00-00-000Z-pf', { scenario: 'p1' });
  assert.equal(previousRunOf(root, 'p1'), null);
});

test('预设失败的 run 收尾之后不再重复进跑前清场', (t) => {
  const root = tmpRepo(t);
  const runDir = writePresetFailedRun(root, '2026-11-17T01-00-00-000Z-pf', {
    scenario: 'p1',
    created: [{ id: 'aaaa00000000000000000001', projectId: 'x', title: '前置', origin: 'preset' }],
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    JSON.stringify({ ...manifest, cleanupAfter: { deleted: [], failed: [], remaining: [], mismatched: [] } }),
  );
  assert.equal(previousRunOf(root, 'p1'), null);
});

// #16 的核心接线：会话必须以 work/ 为 cwd，且 PATH 里前置的是 shim/。
// 这两条是这次改动唯一的实际效果，之前没有任何测试碰得到——把 cwd 改回
// sandbox.root 会让 agent 重新看到 shim 与配置，而测试仍然全绿。
test('sessionEnvOf：PATH 前置 shim、CLAUDE_CONFIG_DIR 指向 config', () => {
  const sandbox = {
    binDir: 'C:\run-x\shim',
    configDir: 'C:\run-x\config',
  };
  const env = sessionEnvOf({ sandbox, callLogPath: 'C:\logs\calls.ndjson', createdFile: 'C:\logs\created.ndjson' });

  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  assert.ok(env[pathKey].startsWith('C:\run-x\shim'), 'PATH 必须以 shim/ 开头');
  assert.equal(env.CLAUDE_CONFIG_DIR, 'C:\run-x\config');
  assert.equal(env.DIDA_CALL_LOG, 'C:\logs\calls.ndjson');
  assert.equal(env.DIDA_CREATED_FILE, 'C:\logs\created.ndjson');
});

// cwd 必须是 work/ 而不是整个运行目录——这是 #16 改动的全部意义。
// 直接读源码断言这条耦合：runOneSession 若改回 sandbox.root，这条会红。
test('会话以 work/ 为 cwd，而不是整个运行目录', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, 'run.mjs'), 'utf8');
  assert.match(source, /cwd: sandbox\.workDir/, 'cwd 必须是 sandbox.workDir');
  assert.doesNotMatch(source, /cwd: sandbox\.root/, 'cwd 不该是 sandbox.root：那会让 agent 看到 shim 与配置');
});
