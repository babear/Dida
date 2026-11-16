import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { credibilityOf, hasCleanupProblem, stateLine, takeState, verdictLines, writeManifest, writeUnusableRun } from './run.mjs';

function tmpRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 前置门（ADR-0014）：会话没正常结束时判定链根本不开始。三条用例锁的就是
// 「不取快照」——快照的构建被调用这件事本身就是判定链开始了的证据。

test('会话没正常结束时不构建终态快照，state.json 不生成', (t) => {
  const dir = tmpRepo(t);
  const statePath = path.join(dir, 'state.json');
  let built = 0;

  const out = takeState({ completed: false, statePath, build: () => { built += 1; return [{ id: 'a' }]; } });

  assert.equal(built, 0, '没跑完的会话没有产出可判的事实，不该去枚举清单');
  assert.equal(fs.existsSync(statePath), false, 'state.json 不存在才是诚实的');
  assert.equal(out.status, 'not-started', '「没开始」与「取失败」不是一回事');
  assert.deepEqual(out.state, []);
});

test('会话正常结束时才取快照并落盘', (t) => {
  const dir = tmpRepo(t);
  const statePath = path.join(dir, 'state.json');

  const out = takeState({ completed: true, statePath, build: () => [{ id: 'a' }] });

  assert.equal(out.status, 'ok');
  assert.deepEqual(out.state, [{ id: 'a' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), [{ id: 'a' }]);
});

test('取快照失败时不写 state.json，也不抛——manifest 与清场还得照常跑', (t) => {
  const dir = tmpRepo(t);
  const statePath = path.join(dir, 'state.json');

  const out = takeState({
    completed: true,
    statePath,
    build: () => { throw new Error('网络抖动'); },
  });

  assert.equal(out.status, 'failed');
  assert.equal(out.error, '网络抖动');
  assert.equal(fs.existsSync(statePath), false);
});

test('控制台的 state 行把「没取」与「取失败」分开写', () => {
  const notStarted = stateLine({ state: { path: 'x', status: 'not-started', count: null, error: null } });
  const failed = stateLine({ state: { path: 'x', status: 'failed', count: null, error: '网络抖动' } });

  assert.match(notStarted, /未取/);
  assert.match(notStarted, /判定链未开始/);
  assert.match(failed, /未落盘/);
  assert.match(failed, /网络抖动/);
  assert.doesNotMatch(failed, /判定链未开始/);
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
