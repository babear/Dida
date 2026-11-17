import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decideAssertion, loadAssert, runAssert } from './assertion.mjs';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeAssert(t, source) {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'assert.mjs'), source);
  return dir;
}

const INPUT = {
  created: [{ id: 'a', origin: 'agent' }],
  calls: [],
  session: { exitCode: 0 },
};

const CONSISTENT = { status: 'consistent', detail: '1 条 dida 调用 / 1 次 PowerShell' };

// 取快照成功的最小替身。快照只在可信度检查通过之后才被调用（ADR-0014），
// 因此下面每个「过了前置门与可信度」的用例都要显式给出它。
function okSnapshot(tasks = [{ id: 'a', kind: 'TEXT' }]) {
  return () => ({ status: 'ok', state: tasks, error: null });
}

function failSnapshot(error = '网络抖动') {
  return () => ({ status: 'failed', state: [], error });
}

test('用例目录里有 assert.mjs 时加载它的默认导出', async (t) => {
  const dir = writeAssert(t, 'export default function assert() { return [{ ok: true, name: "x" }]; }\n');
  const fn = await loadAssert(dir);
  assert.equal(typeof fn, 'function');
  assert.deepEqual(await fn(INPUT), [{ ok: true, name: 'x' }]);
});

test('缺 assert.mjs 时返回 null——调用方据此判「缺断言」而不是开跑', async (t) => {
  assert.equal(await loadAssert(tmpDir(t)), null);
});

test('断言函数原样收到 tasks / created / calls / session', async (t) => {
  const dir = writeAssert(
    t,
    'export default function assert(input) { return [{ ok: true, name: "input", expected: input.tasks.length, actual: input.tasks.length }]; }\n',
  );
  const { usable, results } = await runAssert(await loadAssert(dir), { ...INPUT, tasks: [{ id: 'a' }] });
  assert.equal(usable, true);
  assert.deepEqual(results, [{ ok: true, name: 'input', expected: 1, actual: 1 }]);
});

test('断言返回空数组即通过', async () => {
  const { usable, results } = await runAssert(() => [], INPUT);
  assert.equal(usable, true);
  assert.deepEqual(results, []);
});

test('断言模块抛异常时标 usable=false，并说明原因', async () => {
  const { usable, results } = await runAssert(() => {
    throw new Error('t.title 是 undefined');
  }, INPUT);
  assert.equal(usable, false);
  assert.match(results[0].actual, /t\.title 是 undefined/);
});

test('断言返回的不是数组时标 usable=false', async () => {
  const { usable, results } = await runAssert(() => ({ ok: true }), INPUT);
  assert.equal(usable, false);
  assert.match(results[0].name, /数组/);
});

test('数组里混了 null / undefined 时归一成失败项，且标成「用例写错了」而不是断言失败', async () => {
  const { usable, results } = await runAssert(() => [null, undefined, { ok: true, name: '正常' }], INPUT);
  assert.equal(usable, false, '元素形状不对指向用例，不是 skill 没做到');
  assert.equal(results.length, 3);
  assert.match(results[0].name, /第 1 项/);
  assert.match(results[1].name, /第 2 项/);
  assert.equal(results[2].ok, true);
  // 归一化之后 every 能正常求值——这是崩溃的实际触发点
  assert.equal(results.every((result) => result.ok), false);
  // malformed 标记是内部的，不该漏进给断言作者看的结果里
  assert.equal(Object.hasOwn(results[0], 'malformed'), false);
});

test('稀疏数组不能一条断言都没跑就判通过', async () => {
  const { usable, results } = await runAssert(() => new Array(5), INPUT);
  assert.equal(usable, false, 'new Array(5) 是空位数组，不是「零条断言」');
  assert.equal(results.length, 5, '每个空位都要变成一条失败项');
  assert.equal(results.some((_, index) => !(index in results)), false, '不应残留空位');
  assert.equal(results.every((result) => result.ok), false);
});

test('元素缺布尔 ok 时也算形状不对', async () => {
  const { results } = await runAssert(() => [{ ok: 'yes', name: 'x' }], INPUT);
  assert.equal(results[0].ok, false);
  assert.match(results[0].name, /形状不对/);
});

// 前置门：会话没正常结束时判定链根本不开始（ADR-0014）。快照与断言都不该被碰到——
// 它们被调用这件事本身就是「判定链开始了」的证据。
test('会话没正常结束 → incomplete，快照不取、断言不评', async () => {
  let taken = 0;
  let called = 0;
  const out = await decideAssertion({
    completed: false,
    takeSnapshot: () => { taken += 1; return { status: 'ok', state: [], error: null }; },
    assertionFn: () => { called += 1; return [{ ok: true }]; },
    input: INPUT,
  });
  assert.equal(out.status, 'incomplete');
  assert.equal(taken, 0);
  assert.equal(called, 0);
  assert.equal(out.snapshot.status, 'not-taken');
});

test('会话没正常结束时，前置门先于可信度检查：可信度不过也报 incomplete', async () => {
  let called = 0;
  const out = await decideAssertion({
    completed: false,
    crossCheck: { status: 'inconsistent', detail: '3 条 dida 调用 / 10 次 PowerShell' },
    takeSnapshot: () => { throw new Error('不该被调用'); },
    assertionFn: () => { called += 1; return [{ ok: true }]; },
    input: INPUT,
  });
  assert.equal(out.status, 'incomplete', '没有可判的事实，可信度检查无从谈起');
  assert.deepEqual(out.results, [], '判定链未开始，一条结论都不该有');
  assert.equal(called, 0);
});

test('会话没正常结束时不进入快照那一面，也就没有 cause', async () => {
  const out = await decideAssertion({
    completed: false,
    takeSnapshot: () => { throw new Error('不该被调用'); },
    assertionFn: () => { throw new Error('不该被调用'); },
    input: INPUT,
  });
  assert.equal(out.status, 'incomplete');
  assert.equal(out.cause, undefined);
});

test('断言全过 → passed', async () => {
  const out = await decideAssertion({
    completed: true, crossCheck: CONSISTENT, takeSnapshot: okSnapshot(),
    assertionFn: () => [{ ok: true }], input: INPUT,
  });
  assert.equal(out.status, 'passed');
});

test('断言有失败项 → failed（去改 skill）', async () => {
  const out = await decideAssertion({
    completed: true, crossCheck: CONSISTENT, takeSnapshot: okSnapshot(),
    assertionFn: () => [{ ok: false, name: 'x' }], input: INPUT,
  });
  assert.equal(out.status, 'failed');
});

test('快照取不到 → invalid（重跑），不是 failed，断言不跑', async () => {
  let called = 0;
  const out = await decideAssertion({
    completed: true,
    crossCheck: CONSISTENT,
    takeSnapshot: failSnapshot(),
    assertionFn: () => { called += 1; return [{ ok: true }]; },
    input: INPUT,
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'state');
  assert.match(out.detail, /网络抖动/);
  assert.match(out.detail, /重跑/);
  assert.equal(called, 0, '快照取不到时断言没有可读的事实');
});

test('断言模块抛异常 → broken（去改用例），不是 failed', async () => {
  const out = await decideAssertion({
    completed: true, crossCheck: CONSISTENT, takeSnapshot: okSnapshot(),
    assertionFn: () => { throw new Error('崩了'); },
    input: INPUT,
  });
  assert.equal(out.status, 'broken');
  assert.match(out.detail, /合法的结果数组/);
});

test('断言返回非数组 → broken（去改用例）', async () => {
  const out = await decideAssertion({
    completed: true, crossCheck: CONSISTENT, takeSnapshot: okSnapshot(),
    assertionFn: () => 'nope', input: INPUT,
  });
  assert.equal(out.status, 'broken');
});

test('归一化阶段自己炸了（坏了元素的 actual 循环引用）也不抛，折成 broken 让清场照跑', async () => {
  const circular = {};
  circular.self = circular;
  // 元素没有布尔 ok → 走 normalizeResult 的 JSON.stringify 分支，循环引用会抛
  const out = await decideAssertion({
    completed: true,
    crossCheck: CONSISTENT,
    takeSnapshot: okSnapshot(),
    assertionFn: () => [{ name: 'x', actual: circular }],
    input: INPUT,
  });
  assert.equal(out.status, 'broken');
  assert.match(out.detail, /断言阶段异常/);
});

test('快照失败的空消息也判 invalid，不靠 message 的真假', async () => {
  // 用布尔标志表达失败：空消息的 error 会让「if (error)」变 falsy，
  // 那样会写下空 state.json 并让断言在 [] 上判 FAILED。
  const out = await decideAssertion({
    completed: true,
    crossCheck: CONSISTENT,
    takeSnapshot: failSnapshot(''),
    assertionFn: () => [{ ok: true }],
    input: INPUT,
  });
  assert.equal(out.status, 'invalid');
});

test('可信度检查不一致 → invalid，且快照不取、断言不跑', async () => {
  let taken = 0;
  let called = 0;
  const out = await decideAssertion({
    completed: true,
    crossCheck: { status: 'inconsistent', detail: '3 条 dida 调用 / 10 次 PowerShell' },
    takeSnapshot: () => { taken += 1; return { status: 'ok', state: [], error: null }; },
    assertionFn: () => { called += 1; return [{ ok: true }]; },
    input: INPUT,
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'cross-check');
  assert.match(out.detail, /3 条 dida 调用 \/ 10 次 PowerShell/);
  assert.match(out.detail, /重跑不一定能解决/);
  assert.equal(taken, 0, '快照的唯一消费者是结局断言，这一面已经红了');
  assert.equal(called, 0);
  assert.equal(out.snapshot.status, 'not-taken');
});

test('可信度检查无法判定 → invalid，cause=indeterminate，快照同样不取', async () => {
  let taken = 0;
  const out = await decideAssertion({
    completed: true,
    crossCheck: { status: 'indeterminate', detail: '0 条 dida 调用 / 0 次 PowerShell' },
    takeSnapshot: () => { taken += 1; return { status: 'ok', state: [], error: null }; },
    assertionFn: () => [{ ok: true }],
    input: INPUT,
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'indeterminate');
  assert.match(out.detail, /轨迹读不出可比对的调用/);
  assert.equal(taken, 0);
});

test('快照失败带 cause=state，措辞指向重跑', async () => {
  const out = await decideAssertion({
    completed: true,
    crossCheck: CONSISTENT,
    takeSnapshot: failSnapshot(),
    assertionFn: () => [{ ok: true }],
    input: INPUT,
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'state');
  assert.match(out.detail, /重跑/);
});

test('可信度检查通过时不影响断言判定', async () => {
  const passed = await decideAssertion({
    completed: true, crossCheck: CONSISTENT, takeSnapshot: okSnapshot(),
    assertionFn: () => [{ ok: true }], input: INPUT,
  });
  assert.equal(passed.status, 'passed');

  const failed = await decideAssertion({
    completed: true, crossCheck: CONSISTENT, takeSnapshot: okSnapshot(),
    assertionFn: () => [{ ok: false, name: 'x' }], input: INPUT,
  });
  assert.equal(failed.status, 'failed');
});

test('不传 crossCheck（旧调用方）时行为与之前一致', async () => {
  const out = await decideAssertion({
    completed: true, takeSnapshot: okSnapshot(), assertionFn: () => [{ ok: true }], input: INPUT,
  });
  assert.equal(out.status, 'passed');
});

test('会话正常结束且可信度通过时，才轮到结局断言', async () => {
  let called = 0;
  const out = await decideAssertion({
    completed: true, crossCheck: CONSISTENT, takeSnapshot: okSnapshot(),
    assertionFn: () => { called += 1; return [{ ok: true }]; },
    input: INPUT,
  });
  assert.equal(out.status, 'passed');
  assert.equal(called, 1);
});

// 可信度失败即终止判定链（ADR-0014）：断言模块连调用都不该有。用调用计数验证，
// 光看 status 挡不住回归——#33 曾经让断言照跑、只把结论旁路存进 evaluated。
// 一次 Get-ChildItem 就足以触发可信度失败，断言若照跑，报告里就会并排出现
// 「结果不可信」和一组真假难辨的断言结论，正是 ADR-0014 要消除的形状。

test('可信度不一致时断言模块不被调用，只留可信度这一面结论', async () => {
  let called = 0;
  const out = await decideAssertion({
    completed: true,
    crossCheck: { status: 'inconsistent', detail: '3 条 dida 调用 / 4 次 PowerShell' },
    takeSnapshot: () => { throw new Error('不该被调用'); },
    assertionFn: () => {
      called += 1;
      return [{ ok: false, name: '父任务应为 TEXT', expected: 'TEXT', actual: 'CHECKLIST' }];
    },
    input: INPUT,
  });
  assert.equal(called, 0, '判定链在第一面就停了，断言模块不该被调用');
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'cross-check');
  assert.equal(out.results[0].name, '可信度检查');
  assert.equal(Object.hasOwn(out, 'evaluated'), false, 'evaluated 已拆除，不应再出现在返回值里');
});

test('可信度无法判定时断言模块同样不被调用', async () => {
  let called = 0;
  const out = await decideAssertion({
    completed: true,
    crossCheck: { status: 'indeterminate', detail: '0 条 dida 调用 / 0 次 PowerShell' },
    takeSnapshot: () => { throw new Error('不该被调用'); },
    assertionFn: () => { called += 1; return [{ ok: true }]; },
    input: INPUT,
  });
  assert.equal(called, 0);
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'indeterminate');
  assert.equal(Object.hasOwn(out, 'evaluated'), false);
});

test('可信度结论写进 detail 与 results，不因短路而丢', async () => {
  const out = await decideAssertion({
    completed: true,
    crossCheck: { status: 'inconsistent', detail: '1 次 dida 调用在日志里找不到对应：task create --title z' },
    takeSnapshot: () => { throw new Error('不该被调用'); },
    assertionFn: () => { throw new Error('不该被调用'); },
    input: INPUT,
  });
  // 第一面的结论要完整：点名了哪次调用（detail 与 actual）、以及 cause 决定的标题口径
  assert.match(out.detail, /task create --title z/);
  assert.match(out.results[0].actual, /task create --title z/);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results.length, 1);
});

// 快照的位置约束只剩两条：在可信度检查之后、在清场之前（ADR-0014）。
// 「之后」由上面那组「可信度失败时 taken=0」的用例钉住，「先于断言」由下面这条钉住。
test('快照先于断言取——断言读的就是刚取到的事实', async () => {
  const order = [];
  await decideAssertion({
    completed: true,
    crossCheck: CONSISTENT,
    takeSnapshot: () => { order.push('snapshot'); return { status: 'ok', state: [], error: null }; },
    assertionFn: () => { order.push('assert'); return [{ ok: true }]; },
    input: INPUT,
  });
  assert.deepEqual(order, ['snapshot', 'assert']);
});

test('断言收到的 tasks 只能来自这一次的快照', async () => {
  let seen;
  const tasks = [{ id: 'fresh' }];
  await decideAssertion({
    completed: true,
    crossCheck: CONSISTENT,
    takeSnapshot: () => ({ status: 'ok', state: tasks, error: null }),
    assertionFn: (input) => { seen = input.tasks; return [{ ok: true }]; },
    input: { ...INPUT, tasks: [{ id: 'stale' }] },
  });
  assert.deepEqual(seen, tasks);
});

// 快照这一面红了就停：它不可用时断言读到的是 []，那组结论只会把人引偏。
test('快照取不到时断言不被调用，也不并排任何断言结论', async () => {
  let called = 0;
  const out = await decideAssertion({
    completed: true,
    crossCheck: CONSISTENT,
    takeSnapshot: failSnapshot(),
    assertionFn: () => { called += 1; return [{ ok: false, name: '父任务应为 TEXT' }]; },
    input: INPUT,
  });
  assert.equal(called, 0);
  assert.equal(out.status, 'invalid');
  assert.deepEqual(out.results.map((result) => result.name), ['终态快照不可用']);
});

test('可信度失败时 detail 里不并加快照错误——快照根本没取过', async () => {
  const out = await decideAssertion({
    completed: true,
    crossCheck: { status: 'inconsistent', detail: '3 / 4' },
    takeSnapshot: () => { throw new Error('不该被调用'); },
    assertionFn: () => [{ ok: true }],
    input: INPUT,
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'cross-check');
  assert.doesNotMatch(out.detail, /终态快照/);
  assert.equal(Object.hasOwn(out, 'evaluated'), false);
});

// 判据改成逐调用比对之后（#18），失败行要说的是「哪几次调用没进日志」，
// 不再是「条数不等」——后者既抓不到总数反多的绕过，还会把文件操作误报成绕过。
test('可信度不一致时 results 行点名没对上的调用，不提条数', async () => {
  const out = await decideAssertion({
    completed: true,
    crossCheck: { status: 'inconsistent', detail: '1 次 dida 调用在日志里找不到对应：task create --title z' },
    takeSnapshot: () => { throw new Error('不该被调用'); },
    assertionFn: () => [{ ok: true }],
    input: INPUT,
  });
  const row = out.results[0];
  assert.match(row.actual, /task create --title z/);
  assert.doesNotMatch(row.actual, /条数/);
  assert.match(row.expected, /都被 shim 记录/);
});

// state.json 与 completed 无关的那套旧语义已作废（ADR-0014）：会话没正常结束时
// 既不取快照也不跑断言，状态只有一个词。会话正常结束时的各面判定见上面的用例。

test('会话没跑完时即使快照构建会失败，也只是 incomplete', async () => {
  let called = 0;
  const out = await decideAssertion({
    completed: false,
    crossCheck: { status: 'consistent', detail: '0 / 0' },
    takeSnapshot: () => { throw new Error('不该被调用'); },
    assertionFn: () => { called += 1; return [{ ok: true }]; },
    input: INPUT,
  });
  assert.equal(out.status, 'incomplete');
  assert.equal(called, 0);
});
