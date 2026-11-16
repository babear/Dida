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
  tasks: [{ id: 'a', kind: 'TEXT' }],
  created: [{ id: 'a', origin: 'agent' }],
  calls: [],
  session: { exitCode: 0 },
};

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
  const { usable, results } = await runAssert(await loadAssert(dir), INPUT);
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

// 前置门：会话没正常结束时判定链根本不开始（ADR-0014）。快照取没取到都不该
// 走到断言模块——断言模块被调用这件事本身就是「判定链开始了」的证据。
test('会话没正常结束 → incomplete，断言不评', async () => {
  let called = 0;
  const out = await decideAssertion({
    completed: false,
    stateFailed: false,
    assertionFn: () => { called += 1; return [{ ok: true }]; },
    input: INPUT,
  });
  assert.equal(out.status, 'incomplete');
  assert.equal(called, 0);
});

test('会话没正常结束时，前置门先于可信度检查：可信度不过也报 incomplete', async () => {
  let called = 0;
  const out = await decideAssertion({
    completed: false,
    crossCheck: { status: 'inconsistent', detail: '3 条 dida 调用 / 10 次 PowerShell' },
    stateFailed: false,
    assertionFn: () => { called += 1; return [{ ok: true }]; },
    input: INPUT,
  });
  assert.equal(out.status, 'incomplete', '没有可判的事实，可信度检查无从谈起');
  assert.deepEqual(out.results, [], '判定链未开始，一条结论都不该有');
  assert.equal(called, 0);
});

test('会话没正常结束且快照取不到时也是 incomplete，不报 invalid(state)', async () => {
  const out = await decideAssertion({
    completed: false,
    stateFailed: true,
    stateError: '网络抖动',
    assertionFn: () => { throw new Error('不该被调用'); },
    input: INPUT,
  });
  assert.equal(out.status, 'incomplete');
  assert.equal(out.cause, undefined, '前置门不过，不进入快照那一面');
});

test('断言全过 → passed', async () => {
  const out = await decideAssertion({ completed: true, stateFailed: false, assertionFn: () => [{ ok: true }], input: INPUT });
  assert.equal(out.status, 'passed');
});

test('断言有失败项 → failed（去改 skill）', async () => {
  const out = await decideAssertion({ completed: true, stateFailed: false, assertionFn: () => [{ ok: false, name: 'x' }], input: INPUT });
  assert.equal(out.status, 'failed');
});

test('快照取不到 → invalid（重跑），不是 failed', async () => {
  const out = await decideAssertion({
    completed: true,
    stateFailed: true,
    stateError: '网络抖动',
    assertionFn: () => { throw new Error('不该被调用'); },
    input: INPUT,
  });
  assert.equal(out.status, 'invalid');
  assert.match(out.detail, /网络抖动/);
});

test('断言模块抛异常 → broken（去改用例），不是 failed', async () => {
  const out = await decideAssertion({
    completed: true,
    stateFailed: false,
    assertionFn: () => { throw new Error('崩了'); },
    input: INPUT,
  });
  assert.equal(out.status, 'broken');
  assert.match(out.detail, /合法的结果数组/);
});

test('断言返回非数组 → broken（去改用例）', async () => {
  const out = await decideAssertion({ completed: true, stateFailed: false, assertionFn: () => 'nope', input: INPUT });
  assert.equal(out.status, 'broken');
});

test('归一化阶段自己炸了（坏了元素的 actual 循环引用）也不抛，折成 broken 让清场照跑', async () => {
  const circular = {};
  circular.self = circular;
  // 元素没有布尔 ok → 走 normalizeResult 的 JSON.stringify 分支，循环引用会抛
  const out = await decideAssertion({
    completed: true,
    stateFailed: false,
    assertionFn: () => [{ name: 'x', actual: circular }],
    input: INPUT,
  });
  assert.equal(out.status, 'broken');
  assert.match(out.detail, /断言阶段异常/);
});

test('快照失败的空消息也判 invalid，不靠 message 的真假', async () => {
  // 用布尔标志表达失败：空消息的 error 会让「if (stateError)」变 falsy，
  // 那样会写下空 state.json 并让断言在 [] 上判 FAILED。
  const out = await decideAssertion({
    completed: true,
    stateFailed: true,
    stateError: '',
    assertionFn: () => [{ ok: true }],
    input: INPUT,
  });
  assert.equal(out.status, 'invalid');
});

test('可信度检查不一致 → invalid，先于快照失败，且不是 broken/failed', async () => {
  const out = await decideAssertion({
    completed: true,
    crossCheck: { status: 'inconsistent', detail: '3 条 dida 调用 / 10 次 PowerShell' },
    stateFailed: true,
    stateError: '网络抖动',
    assertionFn: () => [{ ok: true }],
    input: INPUT,
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'cross-check');
  assert.match(out.detail, /3 条 dida 调用 \/ 10 次 PowerShell/);
  assert.match(out.detail, /重跑不一定能解决/);
});

test('可信度检查无法判定 → invalid，cause=indeterminate，措辞与「不一致」分开', async () => {
  const out = await decideAssertion({
    completed: true,
    crossCheck: { status: 'indeterminate', detail: '0 条 dida 调用 / 0 次 PowerShell' },
    stateFailed: false,
    assertionFn: () => [{ ok: true }],
    input: INPUT,
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'indeterminate');
  assert.match(out.detail, /轨迹读不出可解析的事件/);
});

test('快照失败带 cause=state，措辞指向重跑', async () => {
  const out = await decideAssertion({
    completed: true,
    crossCheck: { status: 'consistent', detail: '3 条 dida 调用 / 3 次 PowerShell' },
    stateFailed: true,
    stateError: '网络抖动',
    assertionFn: () => [{ ok: true }],
    input: INPUT,
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'state');
  assert.match(out.detail, /重跑/);
});

test('可信度检查通过时不影响断言判定', async () => {
  const passed = await decideAssertion({
    completed: true,
    crossCheck: { status: 'consistent', detail: '1 条 dida 调用 / 1 次 PowerShell' },
    stateFailed: false,
    assertionFn: () => [{ ok: true }],
    input: INPUT,
  });
  assert.equal(passed.status, 'passed');

  const failed = await decideAssertion({
    completed: true,
    crossCheck: { status: 'consistent', detail: '1 条 dida 调用 / 1 次 PowerShell' },
    stateFailed: false,
    assertionFn: () => [{ ok: false, name: 'x' }],
    input: INPUT,
  });
  assert.equal(failed.status, 'failed');
});

test('不传 crossCheck（旧调用方）时行为与之前一致', async () => {
  const out = await decideAssertion({
    completed: true, stateFailed: false, assertionFn: () => [{ ok: true }], input: INPUT,
  });
  assert.equal(out.status, 'passed');
});

test('会话正常结束且可信度通过时，才轮到结局断言', async () => {
  let called = 0;
  const out = await decideAssertion({
    completed: true,
    crossCheck: { status: 'consistent', detail: '1 条 dida 调用 / 1 次 PowerShell' },
    stateFailed: false,
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
    assertionFn: () => { called += 1; return [{ ok: true }]; },
    input: INPUT,
  });
  assert.equal(called, 0);
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'indeterminate');
  assert.equal(Object.hasOwn(out, 'evaluated'), false);
});

test('可信度条数与原因写进 results，不因短路而丢', async () => {
  const out = await decideAssertion({
    completed: true,
    crossCheck: { status: 'inconsistent', detail: '3 条 dida 调用 / 4 次 PowerShell' },
    assertionFn: () => { throw new Error('不该被调用'); },
    input: INPUT,
  });
  // 第一面的结论要完整：条数（detail 与 actual）、原因、以及 cause 决定的标题口径
  assert.match(out.detail, /3 条 dida 调用 \/ 4 次 PowerShell/);
  assert.match(out.results[0].actual, /3 条 dida 调用 \/ 4 次 PowerShell/);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results.length, 1);
});

// state.json 与 completed 无关的那套旧语义已作废（ADR-0014）：会话没正常结束时
// 既不取快照也不跑断言，状态只有一个词。会话正常结束时的各面判定见上面的用例。

test('会话没跑完且快照也没取到时，同样只是 incomplete', async () => {
  let called = 0;
  const out = await decideAssertion({
    completed: false,
    crossCheck: { status: 'consistent', detail: '0 / 0' },
    stateFailed: true,
    stateError: '网络抖动',
    assertionFn: () => { called += 1; return [{ ok: true }]; },
    input: INPUT,
  });
  assert.equal(out.status, 'incomplete');
  assert.equal(called, 0);
});

test('可信度结果行的 expected 不声称「调用都能归因」——条数不等不等于有调用没被记录', async () => {
  const out = await decideAssertion({
    completed: true,
    crossCheck: { status: 'inconsistent', detail: '3 / 4' },
    assertionFn: () => [{ ok: true }],
    input: INPUT,
  });
  const row = out.results[0];
  assert.doesNotMatch(row.expected, /调用都能归因/);
  assert.match(row.actual, /不等于有调用没被记录/);
});

test('可信度与快照同时失败时，快照错误也并进 detail', async () => {
  const out = await decideAssertion({
    completed: true,
    crossCheck: { status: 'inconsistent', detail: '3 / 4' },
    stateFailed: true,
    stateError: '网络抖动',
    assertionFn: () => [{ ok: true }],
    input: INPUT,
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'cross-check');
  assert.match(out.detail, /网络抖动/);
  assert.equal(Object.hasOwn(out, 'evaluated'), false, 'evaluated 已拆除，快照错误只并进 detail');
});
