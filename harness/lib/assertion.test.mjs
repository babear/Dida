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
  const { evaluated, results } = await runAssert(await loadAssert(dir), INPUT);
  assert.equal(evaluated, true);
  assert.deepEqual(results, [{ ok: true, name: 'input', expected: 1, actual: 1 }]);
});

test('断言返回空数组即通过', async () => {
  const { evaluated, results } = await runAssert(() => [], INPUT);
  assert.equal(evaluated, true);
  assert.deepEqual(results, []);
});

test('断言模块抛异常时标 evaluated=false，并说明原因', async () => {
  const { evaluated, results } = await runAssert(() => {
    throw new Error('t.title 是 undefined');
  }, INPUT);
  assert.equal(evaluated, false);
  assert.match(results[0].actual, /t\.title 是 undefined/);
});

test('断言返回的不是数组时标 evaluated=false', async () => {
  const { evaluated, results } = await runAssert(() => ({ ok: true }), INPUT);
  assert.equal(evaluated, false);
  assert.match(results[0].name, /数组/);
});

test('数组里混了 null / undefined 时归一成失败项，不让上层 every 抛异常', async () => {
  const { evaluated, results } = await runAssert(() => [null, undefined, { ok: true, name: '正常' }], INPUT);
  assert.equal(evaluated, true, '算出结果了，只是元素形状不对——这是用例缺陷但确实评过');
  assert.equal(results.length, 3);
  assert.match(results[0].name, /第 1 项/);
  assert.match(results[1].name, /第 2 项/);
  assert.equal(results[2].ok, true);
  assert.equal(results.every((result) => result.ok), false);
});

test('元素缺布尔 ok 时也算形状不对', async () => {
  const { results } = await runAssert(() => [{ ok: 'yes', name: 'x' }], INPUT);
  assert.equal(results[0].ok, false);
  assert.match(results[0].name, /形状不对/);
});

test('会话没正常结束 → skipped，断言不评', async () => {
  const out = await decideAssertion({ completed: false, stateError: null, assertionFn: () => { throw new Error('不该被调用'); }, input: INPUT });
  assert.equal(out.status, 'skipped');
});

test('断言全过 → passed', async () => {
  const out = await decideAssertion({ completed: true, stateError: null, assertionFn: () => [{ ok: true }], input: INPUT });
  assert.equal(out.status, 'passed');
});

test('断言有失败项 → failed（去改 skill）', async () => {
  const out = await decideAssertion({ completed: true, stateError: null, assertionFn: () => [{ ok: false, name: 'x' }], input: INPUT });
  assert.equal(out.status, 'failed');
});

test('快照取不到 → invalid（重跑），不是 failed', async () => {
  const out = await decideAssertion({
    completed: true,
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
    stateError: null,
    assertionFn: () => { throw new Error('崩了'); },
    input: INPUT,
  });
  assert.equal(out.status, 'broken');
  assert.match(out.detail, /没能给出结果数组/);
});

test('断言返回非数组 → broken（去改用例）', async () => {
  const out = await decideAssertion({ completed: true, stateError: null, assertionFn: () => 'nope', input: INPUT });
  assert.equal(out.status, 'broken');
});

test('归一化阶段自己炸了（坏了元素的 actual 循环引用）也不抛，折成 broken 让清场照跑', async () => {
  const circular = {};
  circular.self = circular;
  // 元素没有布尔 ok → 走 normalizeResult 的 JSON.stringify 分支，循环引用会抛
  const out = await decideAssertion({
    completed: true,
    stateError: null,
    assertionFn: () => [{ name: 'x', actual: circular }],
    input: INPUT,
  });
  assert.equal(out.status, 'broken');
  assert.match(out.detail, /断言阶段异常/);
});
