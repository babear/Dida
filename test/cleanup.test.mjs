import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { tmpDir } from './helpers.mjs';
import { cleanRun, inspectProjects, planCleanup } from '../harness/lib/cleanup.mjs';

function fakeDida(results) {
  const calls = [];
  const run = (argv) => {
    calls.push(argv);
    const reply = results(argv);
    return { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', exitCode: reply.exitCode ?? 0 };
  };
  return { run, calls };
}

const PROJECTS = ['69abc459ebbdbd00000009f0', '59f736cae4b060e424059e3b'];

test('清单不为空时拒绝开跑，并列出可疑任务', () => {
  const report = inspectProjects(PROJECTS, {
    '69abc459ebbdbd00000009f0': [{ id: 'aaaa00000000000000000001', title: '用户自己建的' }],
    '59f736cae4b060e424059e3b': [],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.foreign, [
    { projectId: '69abc459ebbdbd00000009f0', id: 'aaaa00000000000000000001', title: '用户自己建的' },
  ]);
});

test('两个测试清单都为空时允许开跑', () => {
  const report = inspectProjects(PROJECTS, { [PROJECTS[0]]: [], [PROJECTS[1]]: [] });
  assert.equal(report.ok, true);
  assert.deepEqual(report.foreign, []);
});

test('清场只删 created.json 里记录的 id，同清单里的其它任务让它停下', () => {
  const plan = planCleanup(
    [{ id: 'aaaa00000000000000000001', projectId: PROJECTS[0], title: '本 run 建的' }],
    { [PROJECTS[0]]: [{ id: 'aaaa00000000000000000001', title: '本 run 建的' }] },
  );
  assert.deepEqual(plan.deletes, [{ projectId: PROJECTS[0], id: 'aaaa00000000000000000001' }]);
});

test('清单里出现非本 run 创建的任务时只报错，不清场', () => {
  const plan = planCleanup(
    [{ id: 'aaaa00000000000000000001', projectId: PROJECTS[0], title: '本 run 建的' }],
    { [PROJECTS[0]]: [
      { id: 'aaaa00000000000000000001', title: '本 run 建的' },
      { id: 'bbbb00000000000000000002', title: '未记账的' },
    ] },
  );
  assert.equal(plan.aborted, true);
  assert.deepEqual(plan.deletes, []);
  assert.deepEqual(plan.foreign, [{ projectId: PROJECTS[0], id: 'bbbb00000000000000000002', title: '未记账的' }]);
});

test('created.json 里的 id 已经不在清单里（agent 自己删了）不算异常', () => {
  const plan = planCleanup(
    [{ id: 'aaaa00000000000000000001', projectId: PROJECTS[0], title: '被 agent 删掉' }],
    { [PROJECTS[0]]: [] },
  );
  assert.equal(plan.aborted, false);
  assert.deepEqual(plan.deletes, []);
});

test('created.json 里没有记录时不发任何 delete', (t) => {
  const dida = fakeDida((argv) => (argv[1] === 'filter' ? { stdout: '[]' } : { stdout: '任务已删除\n' }));
  const cleaned = cleanRun({
    dida,
    projects: PROJECTS,
    createdFile: path.join(tmpDir(t), 'missing.json'),
  });
  assert.equal(cleaned.deleted.length, 0);
  assert.equal(dida.calls.length, 0);
});

test('清场遇到未记账任务时停止并返回它，不调用 delete', (t) => {
  const createdFile = path.join(tmpDir(t), 'created.json');
  fs.writeFileSync(createdFile, JSON.stringify([{ id: 'aaaa00000000000000000001', projectId: PROJECTS[0] }]));
  const dida = fakeDida((argv) => {
    if (argv[1] === 'filter') {
      return {
        stdout: JSON.stringify([
          { id: 'aaaa00000000000000000001', title: '本 run 建的' },
          { id: 'bbbb00000000000000000002', title: '别人建的' },
        ]),
      };
    }
    return { stdout: '任务已删除\n' };
  });
  const cleaned = cleanRun({ dida, projects: [PROJECTS[0]], createdFile });
  assert.equal(cleaned.aborted, true);
  assert.deepEqual(cleaned.foreign.map((entry) => entry.id), ['bbbb00000000000000000002']);
  assert.equal(dida.calls.filter((argv) => argv[1] === 'delete').length, 0);
});
