import test from 'node:test';
import assert from 'node:assert/strict';

import { crossCheck, crossCheckStatus } from './calllog.mjs';

test('调用日志的调用数与轨迹里的命令调用数一致时，校验通过', () => {
  const calls = [
    { argv: ['task', 'create', '--title', 'x'] },
    { argv: ['task', 'get', 'inbox', 'a'] },
    { argv: ['project', 'list'] },
  ];
  const toolCalls = [
    { name: 'Skill', input: {} },
    { name: 'PowerShell', input: {} },
    { name: 'PowerShell', input: {} },
    { name: 'Read', input: {} },
    { name: 'PowerShell', input: {} },
  ];
  assert.deepEqual(crossCheck(calls, toolCalls), { calls: 3, shapeCalls: 3, consistent: true });
});

test('调用日志少于轨迹里的命令调用时，标出不一致', () => {
  const calls = [{ argv: ['task', 'create', '--title', 'x'] }];
  const toolCalls = [
    { name: 'PowerShell', input: {} },
    { name: 'PowerShell', input: {} },
  ];
  assert.equal(crossCheck(calls, toolCalls).consistent, false);
});

// 判据只看条数（#18）。这两份输入在轨迹里长得一模一样——真绕过少记了一次调用，
// 与「多跑了一次 Get-ChildItem」产出的条数完全相同——所以判据必然给出同一结论。
// 钉住这个「分不清」的事实：将来若判据引入区分，这条会红。
test('真绕过与文件操作在判据眼里不可区分', () => {
  const log = [{ argv: ['task', 'get'] }];
  const traceWithTwoPowerShell = [{ name: 'PowerShell' }, { name: 'PowerShell' }];
  const out = crossCheck(log, traceWithTwoPowerShell);
  assert.equal(out.calls, 1);
  assert.equal(out.shapeCalls, 2);
  assert.equal(out.consistent, false);
  // 判据的输出里没有任何字段能表达「这 1 次差额是绕过还是文件操作」
  assert.deepEqual(Object.keys(out).sort(), ['calls', 'consistent', 'shapeCalls']);
});

test('轨迹里没有命令调用时，空调用日志也算一致', () => {
  assert.deepEqual(crossCheck([], [{ name: 'Read', input: {} }]), { calls: 0, shapeCalls: 0, consistent: true });
});

test('三态：布尔结果直接映射成 consistent / inconsistent', () => {
  assert.equal(crossCheckStatus({ calls: 3, shapeCalls: 3, consistent: true }), 'consistent');
  assert.equal(crossCheckStatus({ calls: 1, shapeCalls: 2, consistent: false }), 'inconsistent');
});

test('三态：轨迹一条可解析事件都没有时判「无法判定」，不是「一致」', () => {
  const result = crossCheck([], []);
  assert.equal(crossCheckStatus(result, { transcriptUsable: false }), 'indeterminate');
});

test('三态：轨迹可用但没调过 PowerShell 时是「一致」，不是「无法判定」', () => {
  const result = crossCheck([], []);
  assert.equal(crossCheckStatus(result, { transcriptUsable: true }), 'consistent');
});
