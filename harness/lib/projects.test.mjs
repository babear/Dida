import test from 'node:test';
import assert from 'node:assert/strict';

import { parseProjectList, resolveTestProjects, TEST_PROJECTS } from './projects.mjs';

test('parseProjectList 只切分去空白，不给默认值（shim 要区分"没配"与"配了空"）', () => {
  assert.deepEqual(parseProjectList(' aaa , , bbb '), ['aaa', 'bbb']);
  assert.deepEqual(parseProjectList(''), []);
  assert.deepEqual(parseProjectList(undefined), []);
});

test('默认取 Test_1 与 Test_2 两个清单', () => {
  assert.deepEqual(resolveTestProjects({}), TEST_PROJECTS);
  assert.equal(TEST_PROJECTS.length, 2);
});

test('DIDA_TEST_PROJECTS 可覆盖，逗号分隔', () => {
  assert.deepEqual(resolveTestProjects({ DIDA_TEST_PROJECTS: 'aaa,bbb' }), ['aaa', 'bbb']);
});

test('覆盖值里的空白与空项被丢掉', () => {
  assert.deepEqual(resolveTestProjects({ DIDA_TEST_PROJECTS: ' aaa , , bbb ' }), ['aaa', 'bbb']);
});

test('覆盖值为空时退回默认，不让一次运行没有任何测试清单', () => {
  assert.deepEqual(resolveTestProjects({ DIDA_TEST_PROJECTS: '  ' }), TEST_PROJECTS);
});
