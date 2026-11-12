import test from 'node:test';
import assert from 'node:assert/strict';

import { buildState } from './state.mjs';

const P1 = '69abc459ebbdbd00000009f0';
const P2 = '59f736cae4b060e424059e3b';
const A = 'aaaa00000000000000000001';
const B = 'bbbb00000000000000000002';

// 假 CLI：filter 按清单返回任务，get 按 id 查；取不到时与真 CLI 同形——stdout 为空。
function fakeDida(tasksByProject) {
  const calls = [];
  return {
    calls,
    run(argv) {
      calls.push(argv);
      if (argv[1] === 'filter') {
        return { stdout: JSON.stringify(tasksByProject[argv[3]] ?? []), stderr: '', exitCode: 0 };
      }
      const id = argv[3];
      const task = Object.values(tasksByProject).flat().find((t) => t.id === id);
      return task
        ? { stdout: JSON.stringify(task), stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'DIDA API 错误 404: resource_not_found', exitCode: 1 };
    },
  };
}

test('账本里每条任务都取回现状，顺序与账本一致', () => {
  const dida = fakeDida({ [P1]: [{ id: A, kind: 'TEXT' }, { id: B, kind: 'TEXT' }] });
  const state = buildState({
    dida,
    created: [{ id: A, projectId: P1 }, { id: B, projectId: P1 }],
    projects: [P1],
  });

  assert.deepEqual(state.map((task) => task.id), [A, B]);
  // 按清单枚举，每条清单只查一次——不是逐 id 打 API
  assert.deepEqual(dida.calls.filter((c) => c[1] === 'filter').length, 1);
});

test('任务被挪到另一个测试清单后照样取到，不误报成「不在了」', () => {
  // 账本记在 P1，但 agent 用 task move 挪到了 P2
  const dida = fakeDida({ [P1]: [], [P2]: [{ id: A, kind: 'TEXT', projectId: P2 }] });
  const state = buildState({ dida, created: [{ id: A, projectId: P1 }], projects: [P1, P2] });

  assert.deepEqual(state, [{ id: A, kind: 'TEXT', projectId: P2 }]);
});

test('取不到的任务记 null，不影响其余条目', () => {
  const dida = fakeDida({ [P1]: [{ id: B }] });
  const state = buildState({ dida, created: [{ id: A, projectId: P1 }, { id: B, projectId: P1 }], projects: [P1] });
  assert.deepEqual(state, [null, { id: B }]);
});

test('清单都枚举不到时回退到账本记的清单直查', () => {
  const dida = fakeDida({ [P1]: [] });
  const state = buildState({ dida, created: [{ id: A, projectId: P1 }], projects: [P1] });
  assert.equal(state[0], null);
  assert.ok(dida.calls.some((c) => c[1] === 'get'), '应该回退到 task get');
});

test('账本为空时不查任何清单', () => {
  const dida = fakeDida({});
  assert.deepEqual(buildState({ dida, created: [], projects: [P1] }), []);
  assert.deepEqual(dida.calls, []);
});

test('退出码非零但 stdout 是合法 JSON 时照样收下（真 CLI 错误路径会带 libuv 断言）', () => {
  const dida = {
    run: (argv) => (argv[1] === 'filter'
      ? { stdout: '[]', stderr: '', exitCode: 0 }
      : { stdout: JSON.stringify({ id: A, kind: 'TEXT' }), stderr: 'Assertion failed: …', exitCode: 1 }),
  };
  assert.deepEqual(buildState({ dida, created: [{ id: A, projectId: P1 }], projects: [P1] }), [{ id: A, kind: 'TEXT' }]);
});
