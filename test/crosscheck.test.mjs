import test from 'node:test';
import assert from 'node:assert/strict';

import { crossCheck } from '../harness/lib/calllog.mjs';

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
