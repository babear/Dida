import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkPreset, loadPreset, PresetError, runPreset } from './preset.mjs';
import { readCreated } from './created.mjs';

const P1 = '69abc459ebbdbd00000009f0';
const P2 = '59f736cae4b060e424059e3b';
const BLACK = '0000000000000000000000ff';
const PROJECTS = [P1, P2];

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ledger(t) {
  return path.join(tmpDir(t), 'created.ndjson');
}

// 把预设函数写成 scenarioDir/preset.mjs，走 runPreset 的真实加载路径。
function presetDir(t, source) {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'preset.mjs'), source);
  return dir;
}

function presetReturning(t, commands) {
  return presetDir(t, `export default () => ${JSON.stringify(commands)};\n`);
}

// 有状态的假 CLI：每次 create 换一个 id，delete 不参与预设的测试。
function fakeDida({ failAt = 0 } = {}) {
  const calls = [];
  return {
    calls,
    run(argv) {
      calls.push(argv);
      if (failAt && calls.length === failAt) {
        return { stdout: '', stderr: 'DIDA API 错误 500: 服务器错误', exitCode: 1 };
      }
      const n = String(calls.length).padStart(4, '0');
      return { stdout: `已创建: x\nID: 6aee0000000000000000${n}\n`, stderr: '', exitCode: 0 };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// checkPreset：加载时就判，越界的那条命令一条都不执行。
// ─────────────────────────────────────────────────────────────────────────

test('合法的建任务命令放行', () => {
  const out = checkPreset([['task', 'create', '--project', P1, '--title', '买气罐', '--content', '户外用']], PROJECTS);
  assert.deepEqual(out, { ok: true });
});

test('目标清单越界时拒绝，并点名越界的那一个', () => {
  const out = checkPreset([['task', 'create', '--project', BLACK, '--title', 'x']], PROJECTS);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'out-of-bounds');
  assert.equal(out.index, 0);
  assert.match(out.detail, new RegExp(BLACK));
});

test('多条命令里越界的那条被点出来，索引是它在数组里的位置', () => {
  const out = checkPreset([
    ['task', 'create', '--project', P1, '--title', 'a'],
    ['task', 'create', '--project', BLACK, '--title', 'b'],
  ], PROJECTS);
  assert.equal(out.index, 1);
  assert.match(out.detail, /task create --project/);
});

// decide 对 --help 是放行的，targets 为空。放行等于静默空跑——预设什么都没建，
// 用例照样开会话、断言照样红，红的原因却是预设没生效。
test('--help 被拒绝：decide 放行但它什么都不建', () => {
  const out = checkPreset([['task', 'create', '--help']], PROJECTS);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'empty');
  assert.match(out.detail, /--help/);
});

test('裸命令组被拒绝', () => {
  for (const argv of [['task'], ['project', 'group']]) {
    const out = checkPreset([argv], PROJECTS);
    assert.equal(out.reason, 'empty', argv.join(' '));
  }
});

test('只读命令被拒绝：预设只造数据', () => {
  const out = checkPreset([['task', 'get', P1, 't1']], PROJECTS);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'empty');
});

// 建清单会突破测试清单集合的边界，预设不支持。
test('无目标写命令被拒绝，并说明预设不支持这类命令', () => {
  const out = checkPreset([['project', 'create', '--name', '新清单']], PROJECTS);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-target');
  assert.match(out.detail, /不支持无目标写命令/);
});

test('缺 --project 的建任务命令按无目标拒绝', () => {
  const out = checkPreset([['task', 'create', '--title', 'x']], PROJECTS);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-target');
});

test('空预设被拒绝：它一条数据都不建', () => {
  const out = checkPreset([], PROJECTS);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'empty');
});

test('预设函数返回的不是数组时拒绝', () => {
  for (const bad of [undefined, null, {}, 'task create']) {
    const out = checkPreset(bad, PROJECTS);
    assert.equal(out.reason, 'bad-shape', String(bad));
  }
});

test('元素不是字符串数组时拒绝', () => {
  // ['task','create'] 是合法形状（缺目标归 no-target），形状错误只认非数组与非字符串。
  for (const bad of [['task', 1], { argv: [] }, null, []]) {
    const out = checkPreset([bad], PROJECTS);
    assert.equal(out.reason, 'bad-shape', JSON.stringify(bad));
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 任务指针：ADR-0012 的完整表。出现即拒绝，不看它指向的任务在不在本 run 账本里。
// 位置参数按 0 基计，与 guard.mjs 的 positionalAt 一致。
// ─────────────────────────────────────────────────────────────────────────

const TASK_POINTERS = [
  ['task create --parent-id', ['task', 'create', '--project', P1, '--title', 'x', '--parent-id', 't1']],
  ['task update 位置参数 0', ['task', 'update', 't1', '--id', 't1', '--project', P1, '--title', 'x']],
  ['task update --id', ['task', 'update', '--id', 't1', '--project', P1, '--title', 'x']],
  ['task update --parent-id', ['task', 'update', '--id', 't1', '--project', P1, '--parent-id', 't2']],
  ['task move --task', ['task', 'move', '--from', P1, '--to', P2, '--task', 't1']],
  ['task complete 位置参数 1', ['task', 'complete', P1, 't1']],
  ['task delete 位置参数 1', ['task', 'delete', P1, 't1']],
  ['task comment add 位置参数 1', ['task', 'comment', 'add', P1, 't1', '--title', '备注']],
  ['task comment delete 位置参数 1', ['task', 'comment', 'delete', P1, 't1', 'c1']],
  ['task assign --task', ['task', 'assign', '--project', P1, '--task', 't1', '--assignee', 'u']],
  ['task unassign --task', ['task', 'unassign', '--project', P1, '--task', 't1']],
  ['task complete-batch --tasks', ['task', 'complete-batch', '--project', P1, '--tasks', 'a,b']],
  // 子资源指针：不是任务，但同样在账本之外。
  ['project column update 位置参数 1', ['project', 'column', 'update', P1, 'c1', '--name', '列']],
];

for (const [name, argv] of TASK_POINTERS) {
  test(`指向已有任务的参数被拒绝：${name}`, () => {
    const out = checkPreset([argv], PROJECTS);
    assert.equal(out.ok, false, `${argv.join(' ')} 应被拒绝`);
    assert.equal(out.reason, 'task-pointer');
  });
}

test('comment delete 的 commentId（位置参数 2）也计入拒绝：只要多给一个位置参数就够', () => {
  // 位置参数 1（taskId）也在表里，所以 `comment delete <p> <t> <c>` 会先命中它。
  // 这里用「只给 taskId 与 commentId 之外的排布」验证位置参数 2 不是死规则：
  // 把 taskId 放到别处、位置参数 1 给空串，仍要靠位置参数 2 拒绝。
  const out = checkPreset([['task', 'comment', 'delete', P1, '', 'c1']], PROJECTS);
  assert.equal(out.reason, 'task-pointer');
});

// 「出现」按解析出的选项/位置参数判，不按字面匹配。
test('--parent-id 作为 --title 的值时不算出现', () => {
  const out = checkPreset([['task', 'create', '--project', P1, '--title', '--parent-id']], PROJECTS);
  assert.equal(out.ok, true, JSON.stringify(out));
});

test('--tasks 作为 --title 的值时不算出现', () => {
  const out = checkPreset([['task', 'create', '--project', P1, '--title', '--tasks']], PROJECTS);
  assert.equal(out.ok, true, JSON.stringify(out));
});

// ─────────────────────────────────────────────────────────────────────────
// runPreset：先校验、后执行，建出的 id 立刻进本 run 的同一份账本。
// ─────────────────────────────────────────────────────────────────────────

test('预设建出的任务进同一份账本，origin 是 preset', async (t) => {
  const file = ledger(t);
  await runPreset({
    dida: fakeDida(),
    scenarioDir: presetReturning(t, [['task', 'create', '--project', P1, '--title', '买气罐']]),
    projects: PROJECTS,
    createdFile: file,
  });

  const entries = readCreated(file);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries.map((e) => e.origin), ['preset']);
  assert.equal(entries[0].projectId, P1);
  assert.equal(entries[0].title, '买气罐');
});

test('预设拿到的是本次 run 的清单，不是仓库默认常量', async (t) => {
  const dir = presetDir(t, [
    'export default (projects) => {',
    '  globalThis.__received = projects;',
    '  return [["task", "create", "--project", projects[1]]];',
    '};',
    '',
  ].join('\n'));
  await runPreset({ dida: fakeDida(), scenarioDir: dir, projects: PROJECTS, createdFile: ledger(t) });
  assert.deepEqual(globalThis.__received, PROJECTS);
});

test('预设改不动 harness 手里的清单', async (t) => {
  const projects = [...PROJECTS];
  const dir = presetDir(t, [
    'export default (list) => {',
    '  list.length = 0;',
    `  return [["task", "create", "--project", "${P1}"]];`,
    '};',
    '',
  ].join('\n'));
  await runPreset({ dida: fakeDida(), scenarioDir: dir, projects, createdFile: ledger(t) });
  assert.deepEqual(projects, PROJECTS);
});

test('越界时一条命令都不执行', async (t) => {
  const dida = fakeDida();
  await assert.rejects(
    runPreset({
      dida,
      scenarioDir: presetReturning(t, [['task', 'create', '--project', BLACK, '--title', 'x']]),
      projects: PROJECTS,
      createdFile: ledger(t),
    }),
    PresetError,
  );
  assert.deepEqual(dida.calls, []);
});

test('预设在执行前整体校验：后面越界时前面那条也不执行', async (t) => {
  const dida = fakeDida();
  await assert.rejects(
    runPreset({
      dida,
      scenarioDir: presetReturning(t, [
        ['task', 'create', '--project', P1, '--title', 'a'],
        ['task', 'create', '--project', BLACK, '--title', 'b'],
      ]),
      projects: PROJECTS,
      createdFile: ledger(t),
    }),
    PresetError,
  );
  assert.deepEqual(dida.calls, []);
});

test('执行失败时抛错并停下，已建的任务留在账本里', async (t) => {
  const file = ledger(t);
  const dida = fakeDida({ failAt: 2 });
  await assert.rejects(
    runPreset({
      dida,
      scenarioDir: presetReturning(t, [
        ['task', 'create', '--project', P1, '--title', 'a'],
        ['task', 'create', '--project', P1, '--title', 'b'],
        ['task', 'create', '--project', P1, '--title', 'c'],
      ]),
      projects: PROJECTS,
      createdFile: file,
    }),
    PresetError,
  );

  assert.equal(dida.calls.length, 2, '第三条不再执行');
  const entries = readCreated(file);
  assert.equal(entries.length, 1, '第一条已建、要能被 --clean 收掉');
  assert.equal(entries[0].title, 'a');
});

test('预设函数自己抛错时包成 PresetError', async (t) => {
  await assert.rejects(
    runPreset({
      dida: fakeDida(),
      scenarioDir: presetDir(t, 'export default () => { throw new Error("写错了"); };\n'),
      projects: PROJECTS,
      createdFile: ledger(t),
    }),
    (error) => error instanceof PresetError && /写错了/.test(error.message),
  );
});

test('失败的错误消息点名是哪条命令、带了什么 stderr', async (t) => {
  await assert.rejects(
    runPreset({
      dida: fakeDida({ failAt: 1 }),
      scenarioDir: presetReturning(t, [['task', 'create', '--project', P1, '--title', 'a']]),
      projects: PROJECTS,
      createdFile: ledger(t),
    }),
    (error) => /task create --project/.test(error.message) && /DIDA API 错误 500/.test(error.message),
  );
});

test('没有 preset.mjs 时不执行任何命令，也不建账本', async (t) => {
  const dir = tmpDir(t);
  const dida = fakeDida();
  const file = ledger(t);
  await runPreset({ dida, scenarioDir: dir, projects: PROJECTS, createdFile: file });
  assert.deepEqual(dida.calls, []);
  assert.equal(fs.existsSync(file), false);
});

test('preset.mjs 没有默认导出函数时同样判失败，不静默空跑', async (t) => {
  const dida = fakeDida();
  await assert.rejects(
    runPreset({
      dida,
      scenarioDir: presetDir(t, 'export const commands = [];\n'),
      projects: PROJECTS,
      createdFile: ledger(t),
    }),
    (error) => error instanceof PresetError && /没有默认导出的函数/.test(error.message),
  );
  assert.deepEqual(dida.calls, []);
});

// ─────────────────────────────────────────────────────────────────────────
// loadPreset：没有 preset.mjs 的 scenario 行为不变。
// ─────────────────────────────────────────────────────────────────────────

test('没有 preset.mjs 时返回 null', async (t) => {
  assert.equal(await loadPreset(tmpDir(t)), null);
});

test('preset.mjs 默认导出的函数被加载', async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'preset.mjs'), 'export default (projects) => [["task", "create", "--project", projects[0]]];\n');
  const fn = await loadPreset(dir);
  assert.equal(typeof fn, 'function');
  assert.deepEqual(fn([P1]), [['task', 'create', '--project', P1]]);
});

test('preset.mjs 没有默认导出函数时报错，不静默空跑', async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'preset.mjs'), 'export const commands = [];\n');
  await assert.rejects(loadPreset(dir), /没有默认导出的函数/);
});
