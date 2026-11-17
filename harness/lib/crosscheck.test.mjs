import test from 'node:test';
import assert from 'node:assert/strict';

import { crossCheck, crossCheckStatus } from './calllog.mjs';

// 判据在 #18 从「比条数」改成「逐调用比对」：真正的行为覆盖在 powershell.test.mjs，
// 这里只钉 crossCheck / crossCheckStatus 这层适配没走样（三态、轨迹不可用）。

const ps = (command) => ({ name: 'PowerShell', input: { command } });

test('轨迹里的 dida 调用在日志里都有对应时，校验通过', () => {
  const calls = [
    { argv: ['task', 'create', '--title', 'x'] },
    { argv: ['task', 'get', 'inbox', 'a'] },
  ];
  const toolCalls = [
    ps('dida task create --title x'),
    { name: 'Read', input: {} },
    ps('dida task get inbox a'),
  ];
  const out = crossCheck(calls, toolCalls);
  assert.equal(out.status, 'consistent');
  assert.deepEqual(out.unmatched, []);
});

test('轨迹里有 dida 调用在日志里找不到对应时，标出不一致并点名是哪次', () => {
  const calls = [{ argv: ['task', 'get', 'inbox', 'a'] }];
  const toolCalls = [ps('dida task get inbox a'), ps('dida task create --title z')];
  const out = crossCheck(calls, toolCalls);
  assert.equal(out.status, 'inconsistent');
  assert.deepEqual(out.unmatched.map((call) => call.argv), [['task', 'create', '--title', 'z']]);
});

test('非 dida 的 PowerShell 调用不参与比对，也不抬高任何分母', () => {
  const calls = [{ argv: ['project', 'list'] }];
  const toolCalls = [ps('Get-ChildItem'), ps('New-Item x.txt'), ps('dida project list')];
  assert.equal(crossCheck(calls, toolCalls).status, 'consistent');
});

test('轨迹里没有 dida 调用时，空调用日志也算一致', () => {
  assert.equal(crossCheck([], [{ name: 'Read', input: {} }]).status, 'consistent');
});

test('三态：布尔结果不存在了，只有 status 三种取值', () => {
  const out = crossCheck([], [{ name: 'Read', input: {} }]);
  assert.equal('consistent' in out, false, '三态下再留一个布尔会与 status 互相矛盾');
});

test('三态：轨迹一条可解析事件都没有时判「无法判定」，不是「一致」', () => {
  const result = crossCheck([], []);
  assert.equal(crossCheckStatus(result, { transcriptUsable: false }), 'indeterminate');
});

test('三态：轨迹可用但没调过 PowerShell 时是「一致」，不是「无法判定」', () => {
  const result = crossCheck([], []);
  assert.equal(crossCheckStatus(result, { transcriptUsable: true }), 'consistent');
});

test('三态：判据自己判不出时（命令解析不了）也落「无法判定」', () => {
  const result = crossCheck([], [ps('$c = "dida"; & $c task create')]);
  assert.equal(crossCheckStatus(result, { transcriptUsable: true }), 'indeterminate');
});
