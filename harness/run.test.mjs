import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cleanupGate,
  credibilityOf,
  deferredCleanupLine,
  hasCleanupProblem,
  probeAssertNotice,
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

test('用例没跑起来时不建沙箱、不开会话：manifest 里没有会话记录', (t) => {
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

test('credibilityOf：日志条数够时判 consistent', () => {
  const out = credibilityOf({
    calls: [{ argv: ['task', 'get'] }, { argv: ['project', 'list'] }],
    toolCalls: [{ name: 'PowerShell' }, { name: 'PowerShell' }],
    events: [{ type: 'assistant' }],
  });
  assert.equal(out.status, 'consistent');
  assert.equal(out.detail, '2 条 dida 调用 / 2 次 PowerShell');
  assert.equal(out.calls, 2);
});

test('credibilityOf：日志少于轨迹里的 PowerShell 次数时判 inconsistent', () => {
  const out = credibilityOf({
    calls: [{ argv: ['task', 'get'] }],
    toolCalls: [{ name: 'PowerShell' }, { name: 'PowerShell' }, { name: 'PowerShell' }],
    events: [{ type: 'assistant' }],
  });
  assert.equal(out.status, 'inconsistent');
  assert.equal(out.detail, '1 条 dida 调用 / 3 次 PowerShell');
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

test('--keep-sandbox 不阻止清场：它只管沙箱，清场看的是 --hold 与判定结论', () => {
  // README 的参数表把 --keep-sandbox 定义为「成功时也保留沙箱」。
  // 把它并进门控会让 PASSED + --keep-sandbox 连任务一起留下，
  // 与验收标准「只有 PASSED 执行清场」相反。
  assert.equal(cleanupGate({ status: 'passed', hold: false }), false);
});

// 探针永不清场（ADR-0015）：它的全部价值就是现场——任务、沙箱、state.json
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
// 造出两个同义键，spawn 时后者胜出、继承的 PATH 整个丢掉——沙箱里裸 node 就找不到了。
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
