import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cleanRun } from '../harness/lib/cleanup.mjs';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 一个有状态的假清单：delete 会真的把任务移出去，好让"删完还剩什么"可验证。
function fakeStore(initialTasks) {
  const tasks = [...initialTasks];
  const calls = [];
  return {
    calls,
    remaining: () => tasks.map((t) => t.id),
    run(argv) {
      calls.push(argv);
      if (argv[1] === 'filter') return { stdout: JSON.stringify(tasks), stderr: '', exitCode: 0 };
      if (argv[1] === 'delete') {
        const id = argv[3];
        const index = tasks.findIndex((t) => t.id === id);
        if (index === -1) return { stdout: '', stderr: 'task not found', exitCode: 1 };
        tasks.splice(index, 1);
        return { stdout: '任务已删除\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    },
  };
}

const PROJECT = '69abc459ebbdbd00000009f0';

test('本 run 创建的任务被删掉，清单回到空', (t) => {
  const createdFile = path.join(tmpDir(t), 'created.json');
  fs.writeFileSync(createdFile, JSON.stringify([{ id: 'aaaa00000000000000000001', projectId: PROJECT }]));
  const store = fakeStore([{ id: 'aaaa00000000000000000001', title: '本 run 建的' }]);

  const result = cleanRun({ dida: store, projects: [PROJECT], createdFile });

  assert.equal(result.aborted, false);
  assert.deepEqual(result.deleted, ['aaaa00000000000000000001']);
  assert.deepEqual(store.remaining(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(createdFile, 'utf8')), []);
});

test('清单里预置一条非本 run 创建的任务时，harness 停止，那条任务仍在', (t) => {
  const createdFile = path.join(tmpDir(t), 'created.json');
  fs.writeFileSync(createdFile, JSON.stringify([{ id: 'aaaa00000000000000000001', projectId: PROJECT }]));
  const store = fakeStore([
    { id: 'aaaa00000000000000000001', title: '本 run 建的' },
    { id: 'bbbb00000000000000000002', title: '预置的' },
  ]);

  const result = cleanRun({ dida: store, projects: [PROJECT], createdFile });

  assert.equal(result.aborted, true);
  assert.deepEqual(result.foreign.map((e) => e.id), ['bbbb00000000000000000002']);
  // 一条都没删：本 run 的那条也还在
  assert.deepEqual(store.remaining(), ['aaaa00000000000000000001', 'bbbb00000000000000000002']);
  assert.equal(store.calls.filter((argv) => argv[1] === 'delete').length, 0);
});

test('账本里记过、但清单里已经不在的 id 不报错也不发 delete', (t) => {
  const createdFile = path.join(tmpDir(t), 'created.json');
  fs.writeFileSync(createdFile, JSON.stringify([{ id: 'aaaa00000000000000000001', projectId: PROJECT }]));
  const store = fakeStore([]);

  const result = cleanRun({ dida: store, projects: [PROJECT], createdFile });

  assert.equal(result.aborted, false);
  assert.deepEqual(result.deleted, []);
  assert.equal(store.calls.filter((argv) => argv[1] === 'delete').length, 0);
});
