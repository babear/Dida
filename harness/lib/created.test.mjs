import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCreated, recordCreated } from './created.mjs';

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'created-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'created.ndjson');
}

test('task create 的结果把任务 id 记进账本', (t) => {
  const file = tmpFile(t);
  recordCreated(file, {
    argv: ['task', 'create', '--project', 'p1', '--title', 'x'],
    stdout: '已创建: x\nID: 6aee00000000000000000001\n',
  });
  assert.deepEqual(readCreated(file), [
    { id: '6aee00000000000000000001', projectId: 'p1', title: 'x' },
  ]);
});

test('每条记录单独一行，追加而不是重写整个文件', (t) => {
  const file = tmpFile(t);
  recordCreated(file, { argv: ['task', 'create', '--project', 'p1'], stdout: 'ID: 6aee00000000000000000001\n' });
  recordCreated(file, { argv: ['task', 'create', '--project', 'p1'], stdout: 'ID: 6aee00000000000000000002\n' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).id, '6aee00000000000000000001');
  assert.equal(JSON.parse(lines[1]).id, '6aee00000000000000000002');
});

test('--json 输出同样能取到 id', (t) => {
  const file = tmpFile(t);
  recordCreated(file, {
    argv: ['task', 'create', '--project', 'p1', '--json'],
    stdout: '{\n  "id": "6aee00000000000000000003",\n  "projectId": "p1"\n}\n',
  });
  assert.deepEqual(readCreated(file).map((e) => e.id), ['6aee00000000000000000003']);
});

test('id 不是 24 位十六进制时不入账', (t) => {
  const file = tmpFile(t);
  recordCreated(file, { argv: ['task', 'create', '--project', 'p1', '--json'], stdout: '{"id":"abc"}' });
  assert.deepEqual(readCreated(file), []);
});

test('创建失败时（退出码非零）不入账', (t) => {
  const file = tmpFile(t);
  recordCreated(file, {
    argv: ['task', 'create', '--project', 'p1'],
    stdout: '',
    exitCode: 1,
    stderr: 'DIDA API 错误 500',
  });
  assert.deepEqual(readCreated(file), []);
});

test('非创建命令不入账', (t) => {
  const file = tmpFile(t);
  recordCreated(file, { argv: ['task', 'get', 'p1', '6aee00000000000000000005'], stdout: 'ID: 6aee00000000000000000005\n' });
  assert.deepEqual(readCreated(file), []);
});

test('账本不存在时读成空数组', (t) => {
  assert.deepEqual(readCreated(tmpFile(t)), []);
});

test('同一个 id 记了多行时读出去重，只保留一条', (t) => {
  const file = tmpFile(t);
  const record = { argv: ['task', 'create', '--project', 'p1'], stdout: 'ID: 6aee00000000000000000006\n' };
  recordCreated(file, record);
  recordCreated(file, record);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  assert.deepEqual(readCreated(file).map((e) => e.id), ['6aee00000000000000000006']);
});

test('半行残缺（进程被 kill 在写入途中）被跳过，不影响其余记录', (t) => {
  const file = tmpFile(t);
  recordCreated(file, { argv: ['task', 'create', '--project', 'p1'], stdout: 'ID: 6aee00000000000000000007\n' });
  fs.appendFileSync(file, '{"id":"6aee00000000000000000008","proj');
  assert.deepEqual(readCreated(file).map((e) => e.id), ['6aee00000000000000000007']);
});

test('--project 用等号写法时也能取到清单 id', (t) => {
  const file = tmpFile(t);
  recordCreated(file, { argv: ['task', 'create', '--project=p1'], stdout: 'ID: 6aee00000000000000000009\n' });
  assert.equal(readCreated(file)[0].projectId, 'p1');
});
