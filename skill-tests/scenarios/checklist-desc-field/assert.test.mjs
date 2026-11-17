import test from 'node:test';
import assert from 'node:assert/strict';

import assertFn from './assert.mjs';

// 正确结局：2026-11-17 取样拿到的真实形状。
const GOOD = {
  kind: 'CHECKLIST',
  content: '出发前把要带的东西和要做的事过一遍。',
  items: [
    { title: '帐篷、睡袋、防潮垫' },
    { title: '气罐与炉头' },
    { title: '头灯和备用电池' },
    { title: '两天的饮用水' },
    { title: '防蚊液与常用药' },
  ],
};

test('与取样一致的结局全绿', () => {
  const results = assertFn({ tasks: [GOOD] });
  assert.deepEqual(results.filter((r) => !r.ok), []);
});

test('没建出 CHECKLIST 时点到那一条', () => {
  const results = assertFn({ tasks: [{ kind: 'TEXT', content: 'x' }] });
  assert.equal(results[0].ok, false);
  assert.match(results[0].name, /CHECKLIST/);
  assert.deepEqual(results[0].actual, ['TEXT']);
});

test('检查事项数量不对时点到数量那一条', () => {
  const results = assertFn({ tasks: [{ ...GOOD, items: GOOD.items.slice(0, 3) }] });
  const failed = results.filter((r) => !r.ok);
  assert.equal(failed.length, 1);
  assert.match(failed[0].name, /5 条/);
  assert.equal(failed[0].actual, 3);
});

test('说明写进了 desc 时点到那一条——那正是 #25 要防的行为', () => {
  const results = assertFn({ tasks: [{ ...GOOD, content: '', desc: '出发前把要带的东西过一遍。' }] });
  const names = results.filter((r) => !r.ok).map((r) => r.name);
  assert.ok(names.some((n) => /content/.test(n)), `应命中 content 那条：${names.join('、')}`);
  assert.ok(names.some((n) => /desc/.test(n)), `应命中 desc 那条：${names.join('、')}`);
});

test('检查事项标题为空时点到标题那一条', () => {
  const items = [...GOOD.items.slice(0, 4), { title: '' }];
  const results = assertFn({ tasks: [{ ...GOOD, items }] });
  const failed = results.filter((r) => !r.ok);
  assert.equal(failed.length, 1);
  assert.match(failed[0].name, /标题/);
});

// 账本里的任务被 agent 删了时 tasks 里是 null（GLOSSARY「终态快照」）。
test('任务被删（null）时不崩，报「没建出 CHECKLIST」', () => {
  const results = assertFn({ tasks: [null] });
  assert.equal(results[0].ok, false);
  assert.match(results[0].name, /CHECKLIST/);
  assert.deepEqual(results[0].actual, [null]);
});

test('一条任务都没建时同样报「没建出 CHECKLIST」', () => {
  const results = assertFn({ tasks: [] });
  assert.equal(results[0].ok, false);
  assert.deepEqual(results[0].actual, []);
});
