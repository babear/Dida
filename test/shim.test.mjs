import test from 'node:test';
import assert from 'node:assert/strict';

import { classify, forwardTarget } from '../harness/lib/shim.mjs';

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

test('转发目标取的是真 .cmd 的绝对路径，不是 PATH 里的名字', () => {
  assert.equal(forwardTarget({ realDidaCmd: 'D:\\tools\\dida.cmd' }), 'D:\\tools\\dida.cmd');
});

test('没有真 CLI 路径时转发必须报错，不能退化成自递归', () => {
  assert.throws(() => forwardTarget({ realDidaCmd: null }), /dida\.cmd/);
});
