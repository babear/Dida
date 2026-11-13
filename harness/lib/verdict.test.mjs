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

test('快照取不到（invalid, cause=state）写成「结果不可用」，不写成用例配置错误', () => {
  const text = renderVerdict({
    assertion: {
      status: 'invalid',
      cause: 'state',
      detail: '取终态快照失败：列清单 p 的任务失败：网络抖动。这是基础设施故障，重跑一次。',
      results: [{ ok: false, name: '终态快照不可用', expected: '能列出测试清单', actual: '网络抖动' }],
    },
    session: SESSION_OK,
  });
  assert.match(text, /不可用/);
  assert.match(text, /网络抖动/);
  assert.match(text, /重跑一次/);
  assert.doesNotMatch(text, /用例配置错误/);
});

test('可信度失败（invalid, cause=cross-check）的标题指向绕过 shim，与快照失败分开', () => {
  const crossCheckText = renderVerdict({
    assertion: {
      status: 'invalid',
      cause: 'cross-check',
      detail: '调用日志与轨迹对不上：3 条 dida 调用 / 10 次 PowerShell。先查明是偶发还是系统性绕过，重跑不一定能解决。',
      results: [],
    },
    session: SESSION_OK,
  });
  const stateText = renderVerdict({
    assertion: { status: 'invalid', cause: 'state', detail: '取终态快照失败：x', results: [] },
    session: SESSION_OK,
  });
  assert.match(crossCheckText, /绕过/);
  assert.match(crossCheckText, /重跑不一定能解决/);
  assert.doesNotMatch(crossCheckText, /终态快照/);
  assert.match(stateText, /终态快照/);
  assert.doesNotMatch(stateText, /绕过/);
});

test('旧 manifest 的 invalid 没有 cause 时用通用标题，不崩', () => {
  const text = renderVerdict({
    assertion: { status: 'invalid', detail: '取终态快照失败：x', results: [] },
    session: SESSION_OK,
  });
  assert.match(text, /本次结果不可用/);
});

test('断言模块坏（broken）写成用例配置错误，与 invalid 分开', () => {
  const broken = renderVerdict({
    assertion: { status: 'broken', detail: '断言模块没能给出结果数组', results: [] },
    session: SESSION_OK,
  });
  const invalid = renderVerdict({
    assertion: { status: 'invalid', detail: '取终态快照失败：网络抖动', results: [] },
    session: SESSION_OK,
  });
  assert.match(broken, /用例配置错误/);
  assert.doesNotMatch(broken, /不可用/);
  assert.match(invalid, /不可用/);
  assert.doesNotMatch(invalid, /用例配置错误/);
});

test('旧 manifest（没有 assertion 字段）不写「通过」——它根本没评过', () => {
  const text = renderVerdict({ assertion: undefined, session: SESSION_OK });
  assert.doesNotMatch(text, /结局断言 通过/);
  assert.match(text, /未评断言/);
});

test('status 是 skipped 时也不写「通过」', () => {
  const text = renderVerdict({ assertion: { status: 'skipped', results: [] }, session: SESSION_OK });
  assert.doesNotMatch(text, /结局断言 通过/);
  assert.match(text, /未评断言/);
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

test('序列化不了的值（循环引用 / BigInt）折成一句人话，不让报告崩掉', () => {
  const circular = {};
  circular.self = circular;
  const text = renderAssertions([
    { ok: false, name: '循环', expected: circular, actual: 'y' },
    { ok: false, name: '大数', expected: 1n, actual: 'y' },
  ]);
  assert.match(text, /无法序列化/);
  assert.doesNotMatch(text, /object Object/);
});

// 「## 会话」小节的三态：判不出结论时不能写「对得上」。
test('crossCheck 三态：consistent / inconsistent / indeterminate 各写各的，互不冒充', async () => {
  const { renderReport } = await import('./report.mjs');
  const base = {
    scenario: 's', run: 'r', sandbox: '/tmp/x', skill: { sha256: 'a', files: 1, git: {} },
    model: { requested_alias: 'x', alias_mapping: {} },
    session: { exitCode: 0, turns: 1, costUsd: 0 }, created: [], cleanup: { deleted: [] },
    assertion: { status: 'passed', results: [] },
  };
  const at = (status) => renderReport({
    ...base,
    calls: { path: 'c', total: 1, rejected: 0, outOfBounds: 0, crossCheck: { calls: 1, shapeCalls: 1, status } },
  });

  assert.match(at('consistent'), /与轨迹对得上/);
  assert.match(at('inconsistent'), /与轨迹对不上/);
  const unknown = at('indeterminate');
  assert.match(unknown, /无法比对/);
  assert.doesNotMatch(unknown, /与轨迹对得上/, '不知道有没有问题，不能说没问题');
});
