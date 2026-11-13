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

test('调用日志少于轨迹里的命令调用时，标出不一致（shim 可能被绕过）', () => {
  const calls = [{ argv: ['task', 'create', '--title', 'x'] }];
  const toolCalls = [
    { name: 'PowerShell', input: {} },
    { name: 'PowerShell', input: {} },
  ];
  assert.equal(crossCheck(calls, toolCalls).consistent, false);
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
