import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decideAssertion, loadAssert, loadProcessAssert, runAssert, takeSample } from './assertion.mjs';

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

// 取快照成功的最小替身。快照只在会话门与可信度检查都过了之后才被调用（ADR-0015），
// 因此下面每个「过了前两道」的用例都要显式给出它。
function okSnapshot(tasks = [{ id: 'a', kind: 'TEXT' }]) {
  return () => ({ status: 'ok', state: tasks, error: null });
}

function failSnapshot(error = '网络抖动') {
  return () => ({ status: 'failed', state: [], error });
}

// 「已经过了前两道」的最小样本，喂给 decideAssertion。
function sampled(tasks = [{ id: 'a', kind: 'TEXT' }]) {
  return { status: 'sampled', results: [], snapshot: { status: 'ok', state: tasks, error: null } };
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

// 过程断言的可选件：有就加载，没有就是 null（允许缺省），不是错误。
// 过程断言按**一条规则一个目录**组织（scenarios/<id>/process/<rule-id>/）：
// RULE.md 写问题说明，rule.mjs 是判据，evidence.ndjson 是那次运行的原始调用序列。
// 一条用例可以有多条规则，互不干扰；加一条就是加一个目录，harness 不改。
function writeRule(t, scenarioDir, id, source) {
  const dir = path.join(scenarioDir, 'process', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rule.mjs'), source);
  return dir;
}

const GREEN_RULE = 'export default () => [{ ok: true, name: "绿" }];';

test('没有 process/ 目录时返回 null——缺省允许', async (t) => {
  assert.equal(await loadProcessAssert(tmpDir(t)), null);
});

test('process/ 是空目录时也返回 null——没有规则就不判过程这一面', async (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'process'));
  assert.equal(await loadProcessAssert(dir), null);
});

test('一条规则：加载出来是一个能跑的求值函数', async (t) => {
  const scenarioDir = tmpDir(t);
  writeRule(t, scenarioDir, 'no-something', 'export default ({ calls }) => [{ ok: calls.length === 0, name: "没有调用" }];');
  const fn = await loadProcessAssert(scenarioDir);
  assert.equal(typeof fn, 'function');
  assert.deepEqual(await fn({ calls: [] }), [{ ok: true, name: '没有调用', rule: 'no-something' }]);
});

// 多条规则各自独立跑，结果合并；每条带规则 id，报告才能点名是哪条。
test('多条规则：结果合并，逐条标明来自哪条规则', async (t) => {
  const scenarioDir = tmpDir(t);
  writeRule(t, scenarioDir, 'always-red', 'export default () => [{ ok: false, name: "红" }];');
  writeRule(t, scenarioDir, 'always-green', 'export default () => [{ ok: true, name: "绿" }];');
  const results = await (await loadProcessAssert(scenarioDir))({ calls: [] });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.rule).sort(), ['always-green', 'always-red']);
});

test('规则目录缺 rule.mjs 时报错——目录建了却没写判据', async (t) => {
  const scenarioDir = tmpDir(t);
  fs.mkdirSync(path.join(scenarioDir, 'process', 'empty-rule'), { recursive: true });
  await assert.rejects(() => loadProcessAssert(scenarioDir), /rule.mjs/);
});

test('rule.mjs 没有默认导出时抛错——那是用例写错了', async (t) => {
  const scenarioDir = tmpDir(t);
  writeRule(t, scenarioDir, 'bad', 'export const notDefault = 1;');
  await assert.rejects(() => loadProcessAssert(scenarioDir), /没有默认导出的函数/);
});

test('规则 id 取自目录名，不取自文件内容', async (t) => {
  const scenarioDir = tmpDir(t);
  writeRule(t, scenarioDir, 'my-rule-id', GREEN_RULE);
  const results = await (await loadProcessAssert(scenarioDir))({ calls: [] });
  assert.equal(results[0].rule, 'my-rule-id');
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

// ─────────────────────────────────────────────────────────────────────────
// takeSample：两条路径共享的前三步（ADR-0015）。探针与 scenario 都走这里，
// 所以这一组只验「事实取到了没有」，不验任何结论词汇。
// ─────────────────────────────────────────────────────────────────────────

test('会话没正常结束 → incomplete，快照不取', () => {
  let taken = 0;
  const out = takeSample({
    completed: false,
    takeSnapshot: () => { taken += 1; return { status: 'ok', state: [], error: null }; },
  });
  assert.equal(out.status, 'incomplete');
  assert.equal(taken, 0);
  assert.equal(out.snapshot.status, 'not-taken');
});

test('会话没正常结束时，前置门先于可信度检查：可信度不过也报 incomplete', () => {
  const out = takeSample({
    completed: false,
    crossCheck: { status: 'inconsistent', detail: '3 条 dida 调用 / 10 次 PowerShell' },
    takeSnapshot: () => { throw new Error('不该被调用'); },
  });
  assert.equal(out.status, 'incomplete', '没有可判的事实，可信度检查无从谈起');
  assert.deepEqual(out.results, [], '判定链未开始，一条结论都不该有');
});

test('会话没正常结束时不进入快照那一面，也就没有 cause', () => {
  const out = takeSample({
    completed: false,
    takeSnapshot: () => { throw new Error('不该被调用'); },
  });
  assert.equal(out.status, 'incomplete');
  assert.equal(out.cause, undefined);
});

test('会话正常结束且可信度通过 → sampled，快照落进返回值', () => {
  const tasks = [{ id: 'a' }];
  const out = takeSample({ completed: true, crossCheck: CONSISTENT, takeSnapshot: okSnapshot(tasks) });
  assert.equal(out.status, 'sampled');
  assert.deepEqual(out.snapshot.state, tasks);
});

test('可信度检查不一致 → invalid，快照不取', () => {
  let taken = 0;
  const out = takeSample({
    completed: true,
    crossCheck: { status: 'inconsistent', detail: '3 条 dida 调用 / 10 次 PowerShell' },
    takeSnapshot: () => { taken += 1; return { status: 'ok', state: [], error: null }; },
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'cross-check');
  assert.match(out.detail, /3 条 dida 调用 \/ 10 次 PowerShell/);
  assert.match(out.detail, /重跑不一定能解决/);
  assert.equal(taken, 0, '快照是断言的输入，这一面已经红了');
  assert.equal(out.snapshot.status, 'not-taken');
});

test('可信度检查无法判定 → invalid，cause=indeterminate，快照同样不取', () => {
  let taken = 0;
  const out = takeSample({
    completed: true,
    crossCheck: { status: 'indeterminate', detail: '0 条 dida 调用 / 0 次 PowerShell' },
    takeSnapshot: () => { taken += 1; return { status: 'ok', state: [], error: null }; },
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'indeterminate');
  assert.match(out.detail, /轨迹读不出可比对的调用/);
  assert.equal(taken, 0);
});

test('快照取不到 → invalid（重跑），cause=state', () => {
  const out = takeSample({ completed: true, crossCheck: CONSISTENT, takeSnapshot: failSnapshot() });
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'state');
  assert.match(out.detail, /网络抖动/);
  assert.match(out.detail, /重跑/);
});

test('快照失败的空消息也判 invalid，不靠 message 的真假', () => {
  const out = takeSample({ completed: true, crossCheck: CONSISTENT, takeSnapshot: failSnapshot('') });
  assert.equal(out.status, 'invalid');
});

test('可信度条数与原因写进 results，不因短路而丢', () => {
  const out = takeSample({
    completed: true,
    crossCheck: { status: 'inconsistent', detail: '1 次 dida 调用在日志里找不到对应：task create --title z' },
    takeSnapshot: () => { throw new Error('不该被调用'); },
  });
  assert.match(out.detail, /task create --title z/);
  assert.match(out.results[0].actual, /task create --title z/);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results.length, 1);
});

test('可信度失败时 detail 里不并加快照错误——快照根本没取过', () => {
  const out = takeSample({
    completed: true,
    crossCheck: { status: 'inconsistent', detail: '3 / 4' },
    takeSnapshot: () => { throw new Error('不该被调用'); },
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.cause, 'cross-check');
  assert.doesNotMatch(out.detail, /终态快照/);
});

// 判据改成逐调用比对之后（#18），失败行要说的是「哪几次调用没进日志」，
// 不再是「条数不等」——后者既抓不到总数反多的绕过，还会把文件操作误报成绕过。
test('可信度不一致时 results 行点名没对上的调用，不提条数', () => {
  const out = takeSample({
    completed: true,
    crossCheck: { status: 'inconsistent', detail: '1 次 dida 调用在日志里找不到对应：task create --title z' },
    takeSnapshot: () => { throw new Error('不该被调用'); },
  });
  const row = out.results[0];
  assert.match(row.actual, /task create --title z/);
  assert.doesNotMatch(row.actual, /条数/);
  assert.match(row.expected, /都被 shim 记录/);
});

test('不传 crossCheck（旧调用方）时行为与之前一致', () => {
  const out = takeSample({ completed: true, takeSnapshot: okSnapshot() });
  assert.equal(out.status, 'sampled');
});

// 共享段产出的成功词是 sampled，不是 passed——passed 意味着三面全过，
// 而 takeSample 只证明「事实取到了」。用错词会让探针的运行看起来像 judgement。
test('共享段的成功是 sampled，不是 passed', () => {
  const out = takeSample({ completed: true, crossCheck: CONSISTENT, takeSnapshot: okSnapshot() });
  assert.equal(out.status, 'sampled');
  assert.notEqual(out.status, 'passed');
});

// ─────────────────────────────────────────────────────────────────────────
// decideAssertion：只做「快照 → 断言」（ADR-0015）。前置门与可信度检查
// 已由 takeSample 做完，这里再判一遍就是两处各判一次的经典分叉。
// ─────────────────────────────────────────────────────────────────────────

test('样本不是 sampled 时原样返回，断言模块不被调用', async () => {
  for (const sample of [
    { status: 'incomplete', results: [], snapshot: { status: 'not-taken', state: [], error: null } },
    { status: 'invalid', cause: 'cross-check', detail: 'x', results: [], snapshot: { status: 'not-taken', state: [], error: null } },
    { status: 'invalid', cause: 'state', detail: 'y', results: [], snapshot: { status: 'failed', state: [], error: 'y' } },
  ]) {
    let called = 0;
    const out = await decideAssertion({
      sample,
      assertionFn: () => { called += 1; return [{ ok: true }]; },
      input: INPUT,
    });
    assert.equal(out.status, sample.status);
    assert.equal(out.cause, sample.cause);
    assert.equal(called, 0, `${sample.status} 走到 decideAssertion 时断言不该被调用`);
  }
});

test('断言全过 → passed', async () => {
  const out = await decideAssertion({ sample: sampled(), assertionFn: () => [{ ok: true }], input: INPUT });
  assert.equal(out.status, 'passed');
});

test('断言有失败项 → failed（去改 skill）', async () => {
  const out = await decideAssertion({
    sample: sampled(), assertionFn: () => [{ ok: false, name: 'x' }], input: INPUT,
  });
  assert.equal(out.status, 'failed');
});

test('断言模块抛异常 → broken（去改用例），不是 failed', async () => {
  const out = await decideAssertion({
    sample: sampled(), assertionFn: () => { throw new Error('崩了'); }, input: INPUT,
  });
  assert.equal(out.status, 'broken');
  assert.match(out.detail, /合法的结果数组/);
});

test('断言返回非数组 → broken（去改用例）', async () => {
  const out = await decideAssertion({ sample: sampled(), assertionFn: () => 'nope', input: INPUT });
  assert.equal(out.status, 'broken');
});

test('归一化阶段自己炸了（坏了元素的 actual 循环引用）也不抛，折成 broken 让清场照跑', async () => {
  const circular = {};
  circular.self = circular;
  const out = await decideAssertion({
    sample: sampled(),
    assertionFn: () => [{ name: 'x', actual: circular }],
    input: INPUT,
  });
  assert.equal(out.status, 'broken');
  assert.match(out.detail, /断言阶段异常/);
});

test('断言收到的 tasks 只能来自这一次的快照', async () => {
  let seen;
  const tasks = [{ id: 'fresh' }];
  await decideAssertion({
    sample: sampled(tasks),
    assertionFn: (input) => { seen = input.tasks; return [{ ok: true }]; },
    input: { ...INPUT, tasks: [{ id: 'stale' }] },
  });
  assert.deepEqual(seen, tasks);
});

test('返回值里带着这次判定用的快照，供调用方落 manifest', async () => {
  const out = await decideAssertion({
    sample: sampled([{ id: 'a' }]), assertionFn: () => [{ ok: true }], input: INPUT,
  });
  assert.equal(out.snapshot.status, 'ok');
  assert.deepEqual(out.snapshot.state, [{ id: 'a' }]);
});

// 旧签名（completed / crossCheck / takeSnapshot）已作废：两处各判一次会让
// 「共享段说没取、断言那一面说取了」的分叉重新出现。接错线要立刻炸，
// 而不是静默返回一个没结论的对象滑进报告。
// ─────────────────────────────────────────────────────────────────────────
// 过程断言：判定链第三面（ADR-0005 / ADR-0014）。只有结局断言通过才判——
// 没做到的话，谈有没有绕远路没有意义。
//
// 过程断言按 scenario 写（scenarios/<id>/process.mjs），与 assert.mjs 对称：
// 收一份只含调用日志的入参，返回同形的结果数组。没写就是不判过程——允许缺省。
// ─────────────────────────────────────────────────────────────────────────

// 过程断言的替身：记下它实际收到了什么，顺带钉住「只看调用日志」。
function processFn(result) {
  let seen;
  const fn = (input) => {
    seen = input;
    return result;
  };
  fn.seen = () => seen;
  return fn;
}

test('结局断言不通过时不跑过程断言——没做到，不谈绕没绕远路', async () => {
  let called = 0;
  const out = await decideAssertion({
    sample: sampled(),
    assertionFn: () => [{ ok: false, name: '父任务应为 TEXT', expected: 'TEXT', actual: 'CHECKLIST' }],
    input: INPUT,
    processFn: () => { called += 1; return []; },
  });
  assert.equal(out.status, 'failed');
  assert.equal(out.surface, undefined, '结局断言失败时不该标成过程面');
  assert.equal(called, 0);
});

test('结局断言坏掉（broken）时同样不跑过程断言', async () => {
  let called = 0;
  const out = await decideAssertion({
    sample: sampled(),
    assertionFn: () => { throw new Error('崩了'); },
    input: INPUT,
    processFn: () => { called += 1; return []; },
  });
  assert.equal(out.status, 'broken');
  assert.equal(called, 0);
});

// 缺省允许：没有 process.mjs 的用例只判结局，过程那一面标成「未判」而不是「通过」。
test('没写过程断言时判 passed，但标明过程未判', async () => {
  const out = await decideAssertion({
    sample: sampled(),
    assertionFn: () => [{ ok: true }],
    input: INPUT,
  });
  assert.equal(out.status, 'passed');
  assert.deepEqual(out.process, { evaluated: false, results: [] }, '未判不能冒充通过');
});

test('结局断言通过后跑过程断言，全过 → passed，过程结果分开存在 process 里', async () => {
  const out = await decideAssertion({
    sample: sampled(),
    assertionFn: () => [{ ok: true, name: '父任务正文非空', expected: '非空', actual: '非空' }],
    input: INPUT,
    processFn: processFn([{ ok: true, name: '不存在删除后再建', expected: '没有出现', actual: '没有出现' }]),
  });
  assert.equal(out.status, 'passed');
  assert.equal(out.process.evaluated, true);
  assert.equal(out.process.results.length, 1, '过程断言的结果留在 process 里');
  assert.equal(out.results.length, 1, 'results 只放结局断言那几条：两面分开，报告才说得清是哪一面');
});

test('过程断言不通过 → failed，且标成过程面，与结局断言失败区分开', async () => {
  const out = await decideAssertion({
    sample: sampled(),
    assertionFn: () => [{ ok: true, name: '父任务正文非空', expected: '非空', actual: '非空' }],
    input: INPUT,
    processFn: processFn([
      { ok: false, name: '不存在建带 --items 的任务后删除重建', expected: '没有出现', actual: '第 3 条建、第 5 条删、第 7 条重建' },
    ]),
  });
  assert.equal(out.status, 'failed');
  assert.equal(out.surface, 'process');
});

test('过程断言只收到调用日志，收不到快照与轨迹', async () => {
  const fn = processFn([]);
  const calls = [{ argv: ['task', 'get'] }];
  await decideAssertion({
    sample: sampled(),
    assertionFn: () => [{ ok: true }],
    input: { ...INPUT, calls, session: { exitCode: 0 }, created: [{ id: 'z' }] },
    processFn: fn,
  });
  assert.deepEqual(fn.seen(), { calls }, '只给调用日志：轨迹归可信度检查，快照归结局断言');
});

test('过程断言抛异常 → broken，指向 harness 而不是 skill', async () => {
  const out = await decideAssertion({
    sample: sampled(),
    assertionFn: () => [{ ok: true }],
    input: INPUT,
    processFn: () => { throw new Error('过程断言写坏了'); },
  });
  assert.equal(out.status, 'broken');
  assert.equal(out.surface, 'process', '报告要靠它区分改用例还是改 harness');
  assert.match(out.detail, /过程断言/);
});

// 过程断言是 scenario 自己的代码：它返回非法形状说明用例写错了，
// 与 assert.mjs 同一个出口——判 broken，不判 failed。
test('过程断言返回非法结果时判 broken，不静默当成通过', async () => {
  for (const bad of [undefined, {}, [{ name: 'x' }], [{ ok: 'yes' }]]) {
    const out = await decideAssertion({
      sample: sampled(),
      assertionFn: () => [{ ok: true }],
      input: INPUT,
      processFn: () => bad,
    });
    assert.equal(out.status, 'broken', `返回 ${JSON.stringify(bad)} 时不该当成通过`);
    assert.equal(out.surface, 'process');
  }
});

test('只传旧字段、不传 sample 时立刻报错', async () => {
  let called = 0;
  let taken = 0;
  await assert.rejects(
    decideAssertion({
      completed: true,
      crossCheck: { status: 'consistent', detail: '1 / 1' },
      takeSnapshot: () => { taken += 1; return { status: 'ok', state: [], error: null }; },
      assertionFn: () => { called += 1; return [{ ok: true }]; },
      input: INPUT,
    }),
    /需要 sample/,
  );
  assert.equal(called, 0);
  assert.equal(taken, 0, '旧字段一个都不该被执行');
});
