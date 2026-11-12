import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cleanRun, listTasks, planCleanup, snapshotProjects } from './cleanup.mjs';

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'created.ndjson');
}

function writeLedger(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

// 有状态的假清单：delete 真的把任务移出去，好让"删完还剩什么"可验证。
function fakeDida(initialTasksByProject = {}) {
  const tasks = Object.fromEntries(
    Object.entries(initialTasksByProject).map(([projectId, list]) => [projectId, [...list]]),
  );
  const calls = [];
  return {
    calls,
    remaining: (projectId) => (tasks[projectId] ?? []).map((t) => t.id),
    run(argv) {
      calls.push(argv);
      if (argv[1] === 'filter') {
        return { stdout: JSON.stringify(tasks[argv[3]] ?? []), stderr: '', exitCode: 0 };
      }
      if (argv[1] === 'delete') {
        const [, , projectId, id] = argv;
        const list = tasks[projectId] ?? [];
        const index = list.findIndex((t) => t.id === id);
        if (index === -1) return { stdout: '', stderr: 'task not found', exitCode: 1 };
        list.splice(index, 1);
        return { stdout: '任务已删除\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    },
  };
}

const P1 = '69abc459ebbdbd00000009f0';
const P2 = '59f736cae4b060e424059e3b';
const OWN = 'aaaa00000000000000000001';
const OTHER = 'bbbb00000000000000000002';

test('清场只删账本里的 id，清单里的其它任务不受影响', () => {
  const plan = planCleanup(
    [{ id: OWN, projectId: P1 }],
    { [P1]: [{ id: OWN }, { id: OTHER }] },
  );
  assert.deepEqual(plan.deletes, [{ projectId: P1, id: OWN }]);
});

test('清单里全是别人的任务时，一条都不删', () => {
  const plan = planCleanup([{ id: OWN, projectId: P1 }], { [P1]: [{ id: OTHER }] });
  assert.deepEqual(plan.deletes, []);
});

test('账本里的 id 已经不在清单里（agent 自己删了）不报错不删', () => {
  const plan = planCleanup([{ id: OWN, projectId: P1 }], { [P1]: [] });
  assert.deepEqual(plan.deletes, []);
});

test('实际清单与账本记录不一致时用实际清单删，并报出矛盾', () => {
  const plan = planCleanup(
    [{ id: OWN, projectId: P1 }],
    { [P2]: [{ id: OWN }] },
  );
  assert.deepEqual(plan.deletes, [{ projectId: P2, id: OWN }]);
  assert.deepEqual(plan.mismatched, [{ id: OWN, recordedAt: P1, actual: P2 }]);
});

test('账本没记清单时直接从实际清单删', () => {
  const plan = planCleanup([{ id: OWN, projectId: null }], { [P1]: [{ id: OWN }] });
  assert.deepEqual(plan.deletes, [{ projectId: P1, id: OWN }]);
  assert.deepEqual(plan.mismatched, []);
});

test('清场真的删掉自己的任务，别人的任务原样留着', (t) => {
  const ledger = tmpFile(t);
  writeLedger(ledger, [{ id: OWN, projectId: P1 }]);
  const dida = fakeDida({ [P1]: [{ id: OWN }, { id: OTHER }] });

  const result = cleanRun({ dida, projects: [P1], createdFile: ledger });

  assert.deepEqual(result.deleted, [OWN]);
  assert.deepEqual(dida.remaining(P1), [OTHER]);
});

test('账本为空时不发任何命令，也不列清单', (t) => {
  const dida = fakeDida({ [P1]: [] });
  const result = cleanRun({ dida, projects: [P1], createdFile: tmpFile(t) });
  assert.deepEqual(result.deleted, []);
  assert.equal(dida.calls.length, 0);
});

test('删完之后账本里的 id 仍在清单里时，报出未清除', (t) => {
  const ledger = tmpFile(t);
  writeLedger(ledger, [{ id: OWN, projectId: P1 }]);
  // 假清单：delete 声称成功但任务没消失，模拟服务端静默失败
  const calls = [];
  const dida = {
    run(argv) {
      calls.push(argv);
      if (argv[1] === 'filter') return { stdout: JSON.stringify([{ id: OWN }]), stderr: '', exitCode: 0 };
      return { stdout: '任务已删除\n', stderr: '', exitCode: 0 };
    },
  };

  const result = cleanRun({ dida, projects: [P1], createdFile: ledger });

  assert.deepEqual(result.deleted, [OWN]);
  assert.deepEqual(result.remaining, [OWN]);
});

test('删除失败时记录下来，不抛错', (t) => {
  const ledger = tmpFile(t);
  writeLedger(ledger, [{ id: OWN, projectId: P1 }]);
  const dida = fakeDida({ [P1]: [{ id: OWN }] });
  const originalRun = dida.run;
  dida.run = (argv) => (argv[1] === 'delete' ? { stdout: '', stderr: '网络抖动', exitCode: 1 } : originalRun(argv));

  const result = cleanRun({ dida, projects: [P1], createdFile: ledger });

  assert.deepEqual(result.deleted, []);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].stderr, /网络抖动/);
});

test('snapshotProjects 按清单各读一次', () => {
  const dida = fakeDida({ [P1]: [{ id: OWN }], [P2]: [] });
  const snapshot = snapshotProjects(dida, [P1, P2]);
  assert.deepEqual(snapshot[P1].map((t) => t.id), [OWN]);
  assert.deepEqual(snapshot[P2], []);
  assert.equal(dida.calls.filter((c) => c[1] === 'filter').length, 2);
});

test('退出码非零但 stdout 是合法 JSON 时照样收下（真 CLI 错误路径带 libuv 断言）', () => {
  const dida = {
    run: () => ({ stdout: JSON.stringify([{ id: OWN }]), stderr: 'Assertion failed: …', exitCode: 1 }),
  };
  assert.deepEqual(listTasks(dida, P1).map((t) => t.id), [OWN]);
});

test('stdout 不是合法 JSON 时才抛错，并带上 stderr', () => {
  const dida = { run: () => ({ stdout: 'DIDA API 错误 500', stderr: '网络抖动', exitCode: 1 }) };
  assert.throws(() => listTasks(dida, P1), /网络抖动/);
});
