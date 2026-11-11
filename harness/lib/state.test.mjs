import test from 'node:test';
import assert from 'node:assert/strict';

import { buildState } from './state.mjs';

const P1 = '69abc459ebbdbd00000009f0';
const A = 'aaaa00000000000000000001';
const B = 'bbbb00000000000000000002';

// 假 CLI：按 id 返回任务；取不到时与真 CLI 同形——stdout 为空、退出码非零。
function fakeDida(tasksById) {
  const calls = [];
  return {
    calls,
    run(argv) {
      calls.push(argv);
      const task = tasksById[argv[3]];
      return task
        ? { stdout: JSON.stringify(task), stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'DIDA API 错误 404: resource_not_found', exitCode: 1 };
    },
  };
}

test('账本里每条任务都按 id 取一次现状，顺序与账本一致', () => {
  const dida = fakeDida({
    [A]: { id: A, kind: 'TEXT', content: '正文' },
    [B]: { id: B, kind: 'TEXT', parentId: A },
  });

  const state = buildState({ dida, created: [{ id: A, projectId: P1 }, { id: B, projectId: P1 }] });

  assert.deepEqual(state.map((task) => task.id), [A, B]);
  assert.deepEqual(dida.calls, [
    ['task', 'get', P1, A, '--json'],
    ['task', 'get', P1, B, '--json'],
  ]);
});

test('取不到的任务记 null，不影响其余条目', () => {
  const dida = fakeDida({ [B]: { id: B } });
  const state = buildState({ dida, created: [{ id: A, projectId: P1 }, { id: B, projectId: P1 }] });
  assert.deepEqual(state, [null, { id: B }]);
});

test('账本为空时不发任何命令', () => {
  const dida = fakeDida({});
  assert.deepEqual(buildState({ dida, created: [] }), []);
  assert.deepEqual(dida.calls, []);
});
