import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { tmpDir } from './helpers.mjs';
import { readCreated, recordCreated } from '../harness/lib/created.mjs';

test('task create 的结果把任务 id 记进 created.json', (t) => {
  const file = path.join(tmpDir(t), 'created.json');
  recordCreated(file, {
    argv: ['task', 'create', '--project', 'p1', '--title', 'x'],
    stdout: '已创建: x\nID: 6aee00000000000000000001\n',
  });
  assert.deepEqual(readCreated(file).map((e) => e.id), ['6aee00000000000000000001']);
});

test('记账带清单 id 与标题，便于事后核对', (t) => {
  const file = path.join(tmpDir(t), 'created.json');
  recordCreated(file, {
    argv: ['task', 'create', '--project', 'p1', '--title', '周末露营'],
    stdout: '已创建: 周末露营\nID: 6aee00000000000000000002\n',
  });
  assert.deepEqual(readCreated(file), [
    { id: '6aee00000000000000000002', projectId: 'p1', title: '周末露营' },
  ]);
});

test('--json 输出的创建结果同样能取到 id', (t) => {
  const file = path.join(tmpDir(t), 'created.json');
  recordCreated(file, {
    argv: ['task', 'create', '--project', 'p1', '--json'],
    stdout: '{\n  "id": "6aee00000000000000000003",\n  "projectId": "p1",\n  "title": "t"\n}\n',
  });
  assert.equal(readCreated(file)[0].id, '6aee00000000000000000003');
});

test('同一个 id 只记一条，重复上报不膨胀', (t) => {
  const file = path.join(tmpDir(t), 'created.json');
  const entry = { argv: ['task', 'create', '--project', 'p1', '--title', 'x'], stdout: 'ID: 6aee00000000000000000004\n' };
  recordCreated(file, entry);
  recordCreated(file, entry);
  assert.equal(readCreated(file).length, 1);
});

test('创建失败时（退出码非零）不入账', (t) => {
  const file = path.join(tmpDir(t), 'created.json');
  recordCreated(file, {
    argv: ['task', 'create', '--project', 'p1', '--title', 'x'],
    stdout: '',
    exitCode: 1,
    stderr: 'DIDA API 错误 500',
  });
  assert.deepEqual(readCreated(file), []);
});

test('非创建命令不入账', (t) => {
  const file = path.join(tmpDir(t), 'created.json');
  recordCreated(file, { argv: ['task', 'get', 'p1', '6aee00000000000000000005'], stdout: 'ID: 6aee00000000000000000005\n' });
  assert.deepEqual(readCreated(file), []);
});

test('created.json 不存在时读成空数组', (t) => {
  assert.deepEqual(readCreated(path.join(tmpDir(t), 'missing.json')), []);
});

