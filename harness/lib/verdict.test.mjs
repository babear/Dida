import test from 'node:test';
import assert from 'node:assert/strict';

import { renderAssertions, renderVerdict } from './report.mjs';

const SESSION_OK = { exitCode: 0, timedOut: false, turns: 5, costUsd: 0.1 };

test('断言全过时报告写「通过」，不点名任何断言', () => {
  const text = renderVerdict({
    assertion: { status: 'passed', results: [{ ok: true, name: '父任务正文非空', expected: '非空', actual: '非空' }] },
    session: SESSION_OK,
  });
  assert.match(text, /结局断言 通过/);
  assert.doesNotMatch(text, /父任务正文非空/);
});

test('断言未通过时报告点名失败的那条，并同时写出期望值与实际值', () => {
  const text = renderVerdict({
    assertion: {
      status: 'failed',
      results: [
        { ok: true, name: '父任务正文非空', expected: '非空', actual: '非空' },
        { ok: false, name: '恰好一个父任务带 5 条子任务', expected: 1, actual: 4 },
      ],
    },
    session: SESSION_OK,
  });
  assert.match(text, /结局断言 未通过/);
  assert.match(text, /恰好一个父任务带 5 条子任务/);
  assert.match(text, /期望 1/);
  assert.match(text, /实际 4/);
  // 通过的那条不刷屏
  assert.doesNotMatch(text, /父任务正文非空/);
});

test('缺断言写成「用例配置错误」，与「结局断言 未通过」分开', () => {
  const missing = renderVerdict({ assertion: { status: 'missing', results: [] }, session: {} });
  const failed = renderVerdict({
    assertion: { status: 'failed', results: [{ ok: false, name: 'x', expected: 1, actual: 2 }] },
    session: SESSION_OK,
  });
  assert.match(missing, /缺断言/);
  assert.match(missing, /用例配置错误/);
  assert.doesNotMatch(missing, /结局断言 未通过/);
  assert.doesNotMatch(failed, /缺断言/);
});

test('会话没正常结束时不评断言，报告写明会话先失败', () => {
  const text = renderVerdict({
    assertion: { status: 'skipped', results: [] },
    session: { exitCode: 1, timedOut: false },
  });
  assert.match(text, /会话未正常结束/);
});

test('期望值与实际值是对象时按 JSON 写，不写成 [object Object]', () => {
  const text = renderAssertions([
    { ok: false, name: '父任务', expected: { kind: 'TEXT' }, actual: { kind: 'CHECKLIST' } },
  ]);
  assert.match(text, /"kind":"TEXT"/);
  assert.match(text, /"kind":"CHECKLIST"/);
  assert.doesNotMatch(text, /\[object Object\]/);
});
