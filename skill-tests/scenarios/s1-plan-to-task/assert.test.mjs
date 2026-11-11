import test from 'node:test';
import assert from 'node:assert/strict';

import assertionFn from './assert.mjs';

// 正向样本：正确结局——一条 TEXT 父任务，正文有内容，挂 5 条 TEXT 子任务，没有检查事项。
function correctTasks() {
  const parent = { id: 'p', kind: 'TEXT', content: '露营方案：两人同行，营地按人头收费。', childIds: ['c1', 'c2', 'c3', 'c4', 'c5'] };
  const children = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({ id, parentId: 'p', kind: 'TEXT' }));
  return [parent, ...children];
}

function failingNames(tasks) {
  return assertionFn({ tasks, created: [], calls: [], session: {} })
    .filter((result) => !result.ok)
    .map((result) => result.name);
}

test('正确结局：全部断言通过，返回的失败项为空', () => {
  assert.deepEqual(failingNames(correctTasks()), []);
});

test('把五个步骤建成检查事项（--items）时红在「父任务没有检查事项」与父子关系上', () => {
  const tasks = [
    { id: 'p', kind: 'CHECKLIST', content: '露营方案', items: [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }, { title: 'e' }] },
  ];
  const names = failingNames(tasks);
  assert.ok(names.includes('父任务是普通任务而不是检查事项列表'));
  assert.ok(names.includes('父任务没有检查事项'));
  assert.ok(names.includes('父任务正文非空') === false, '正文非空这条本身是通过的，不该报');
});

test('正文为空时红在「父任务正文非空」', () => {
  const tasks = correctTasks();
  tasks[0].content = '';
  assert.deepEqual(failingNames(tasks), ['父任务正文非空']);
});

test('子任务数量不是 5 时红在条数上，期望值与实际值都写出来', () => {
  const tasks = correctTasks();
  tasks[0].childIds = tasks[0].childIds.slice(0, 4);
  tasks.pop();
  const results = assertionFn({ tasks, created: [], calls: [], session: {} });
  const count = results.find((r) => r.name === '父任务挂着 5 条真实子任务');
  assert.equal(count.ok, false);
  assert.equal(count.expected, 5);
  assert.equal(count.actual, 4);
});

test('什么都没建时红在条数上，而不是抛异常', () => {
  const names = failingNames([]);
  assert.ok(names.includes('恰好一条父任务'));
  assert.ok(names.includes('父任务正文非空'));
});

test('账本里有任务取不到（null）时单独报一条', () => {
  const tasks = [...correctTasks(), null];
  assert.ok(failingNames(tasks).includes('账本里的任务都还在'));
});
