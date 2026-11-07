import test from 'node:test';
import assert from 'node:assert/strict';

import { classify } from '../harness/lib/shim.mjs';

test('写命令被认出来，读命令不会', () => {
  assert.equal(classify(['task', 'create', '--title', 'x']), 'write');
  assert.equal(classify(['task', 'get', 'inbox', 'abc']), 'read');
});

test('update / delete / move / complete 都算写', () => {
  for (const args of [['task', 'update', 'a', '--id', 'a'], ['task', 'delete', 'p', 'a'], ['task', 'move', '--from', 'p', '--to', 'q'], ['task', 'complete', 'p', 'a']]) {
    assert.equal(classify(args), 'write', args.join(' '));
  }
});

test('清单自身的写命令也算写', () => {
  assert.equal(classify(['project', 'create', '--name', 'x']), 'write');
  assert.equal(classify(['project', 'list']), 'read');
});

test('评论的新增与删除是写，列表不是', () => {
  assert.equal(classify(['task', 'comment', 'add', 'a', '--content', 'x']), 'write');
  assert.equal(classify(['task', 'comment', 'delete', 'a', 'b']), 'write');
  assert.equal(classify(['task', 'comment', 'list', 'a']), 'read');
});
