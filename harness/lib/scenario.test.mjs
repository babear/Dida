import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listProbes, listScenarios, loadScenario, probesDir, scenariosDir } from './scenario.mjs';

function tmpRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeScenario(repoRoot, id, manifest, materials) {
  const dir = path.join(scenariosDir(repoRoot), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(manifest));
  if (materials) {
    fs.mkdirSync(path.join(dir, 'materials'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'materials', 'plan.md'), materials);
  }
  return dir;
}

function writeProbe(repoRoot, id, manifest, { assertSource } = {}) {
  const dir = path.join(probesDir(repoRoot), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(manifest));
  if (assertSource) fs.writeFileSync(path.join(dir, 'assert.mjs'), assertSource);
  return dir;
}

test('scenariosDir 落在 skill-tests 下，不散在仓库根', (t) => {
  const root = tmpRepo(t);
  const dir = scenariosDir(root);
  assert.equal(path.dirname(dir), path.join(root, 'skill-tests'));
  assert.equal(path.basename(dir), 'scenarios');
});

test('目录不存在时 listScenarios 返回空数组而不是抛错', (t) => {
  assert.deepEqual(listScenarios(tmpRepo(t)), []);
});

test('listScenarios 只列目录、按名排序，忽略散落文件', (t) => {
  const root = tmpRepo(t);
  writeScenario(root, 'z-last', { prompt: 'x' });
  writeScenario(root, 'a-first', { prompt: 'x' });
  fs.writeFileSync(path.join(scenariosDir(root), 'README.md'), 'not a scenario');
  assert.deepEqual(listScenarios(root), ['a-first', 'z-last']);
});

test('loadScenario 读出 prompt 与 materials 目录', (t) => {
  const root = tmpRepo(t);
  writeScenario(root, 's1', { prompt: '请建一条任务' }, '# 计划\n');
  const loaded = loadScenario(root, 's1');
  assert.equal(loaded.id, 's1');
  assert.equal(loaded.prompt, '请建一条任务');
  assert.ok(loaded.materialsDir && fs.existsSync(loaded.materialsDir));
});

test('没有 materials 目录时 materialsDir 为 null', (t) => {
  const root = tmpRepo(t);
  writeScenario(root, 's1', { prompt: 'x' });
  assert.equal(loadScenario(root, 's1').materialsDir, null);
});

test('找不到 scenario 时报错而不是返回半成品', (t) => {
  const root = tmpRepo(t);
  assert.throws(() => loadScenario(root, 'missing'), /scenario not found: missing/);
});

test('仓库根的 scenarios/ 不被读取——目录搬走之后旧路径不能再生效', (t) => {
  const root = tmpRepo(t);
  fs.mkdirSync(path.join(root, 'scenarios', 'legacy'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scenarios', 'legacy', 'scenario.json'),
    JSON.stringify({ prompt: 'x' }),
  );
  assert.deepEqual(listScenarios(root), []);
});

// 规范只把 prompt 定为 scenario.json 的字段。多出来的键不能被静默吞掉，
// 也不能被当成 prompt 的一部分传给被测 agent。
test('scenario.json 的其它键不进 prompt', (t) => {
  const root = tmpRepo(t);
  writeScenario(root, 's1', { prompt: '原话', expected: '这不该出现' });
  const loaded = loadScenario(root, 's1');
  assert.equal(loaded.prompt, '原话');
  assert.equal(Object.hasOwn(loaded, 'expected'), false);
});

test('loadScenario 给出用例目录本身，供调用方查 assert.mjs 在不在', (t) => {
  const root = tmpRepo(t);
  const dir = writeScenario(root, 's1', { prompt: 'x' });
  assert.equal(loadScenario(root, 's1').dir, dir);
});

test('materials 源目录里的子目录结构原样交给运行目录复制', (t) => {
  const root = tmpRepo(t);
  const dir = writeScenario(root, 's1', { prompt: 'x' });
  fs.mkdirSync(path.join(dir, 'materials', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'materials', 'nested', 'deep.md'), 'deep');
  const loaded = loadScenario(root, 's1');
  assert.equal(loaded.materialsDir, path.join(dir, 'materials'));
  assert.ok(fs.existsSync(path.join(loaded.materialsDir, 'nested', 'deep.md')));
});

// 探针与 scenario 是两条路径（ADR-0015），`kind` 是编排层唯一的岔路标记。

test('probesDir 与 scenariosDir 是 skill-tests 下的两个平级目录', (t) => {
  const root = tmpRepo(t);
  assert.deepEqual(
    path.relative(path.join(root, 'skill-tests'), probesDir(root)),
    'probes',
  );
  assert.equal(path.dirname(probesDir(root)), path.dirname(scenariosDir(root)));
});

test('目录不存在时 listProbes 返回空数组而不是抛错', (t) => {
  assert.deepEqual(listProbes(tmpRepo(t)), []);
});

test('listProbes 只列 probes/ 下的目录，与 listScenarios 互不串台', (t) => {
  const root = tmpRepo(t);
  writeScenario(root, 'in-scenarios', { prompt: 'x' });
  writeProbe(root, 'in-probes', { prompt: 'x' });
  assert.deepEqual(listScenarios(root), ['in-scenarios']);
  assert.deepEqual(listProbes(root), ['in-probes']);
});

test('loadScenario 命中 scenarios/ 时 kind 是 scenario', (t) => {
  const root = tmpRepo(t);
  writeScenario(root, 's1', { prompt: 'x' });
  assert.equal(loadScenario(root, 's1').kind, 'scenario');
});

test('loadScenario 命中 probes/ 时 kind 是 probe', (t) => {
  const root = tmpRepo(t);
  writeProbe(root, 'p1', { prompt: 'x' });
  const loaded = loadScenario(root, 'p1');
  assert.equal(loaded.kind, 'probe');
  assert.equal(loaded.dir, path.join(probesDir(root), 'p1'));
});

test('同名时正式用例优先，探针不被跑到', (t) => {
  const root = tmpRepo(t);
  writeScenario(root, 'same', { prompt: '正式用例' });
  writeProbe(root, 'same', { prompt: '探针' });
  const loaded = loadScenario(root, 'same');
  assert.equal(loaded.kind, 'scenario');
  assert.equal(loaded.prompt, '正式用例', '拿到的必须是 scenarios/ 那一份');
});

test('两边都没有时报「找不到」', (t) => {
  assert.throws(() => loadScenario(tmpRepo(t), 'nope'), /scenario not found: nope/);
});

// 探针的断言文件只是草稿，跑之前要能查到它在不在，好提示「未被使用」。
test('探针目录里有没有 assert.mjs 要能被调用方查到', (t) => {
  const root = tmpRepo(t);
  writeProbe(root, 'p1', { prompt: 'x' }, { assertSource: 'export default () => [];\n' });
  writeProbe(root, 'p2', { prompt: 'x' });
  const withAssert = loadScenario(root, 'p1');
  const withoutAssert = loadScenario(root, 'p2');
  assert.equal(withAssert.hasAssert, true);
  assert.equal(withoutAssert.hasAssert, false);
});

// 探针不需要断言才能跑——这正是它与 scenario 的区别（ADR-0015）。
// 缺 assert.mjs 的 scenario 仍由编排层判 MISCONFIGURED，那一条不变。
test('探针能找到就算成功加载，不因为缺 assert.mjs 而报错', (t) => {
  const root = tmpRepo(t);
  writeProbe(root, 'p1', { prompt: '原话' });
  assert.doesNotThrow(() => loadScenario(root, 'p1'));
});

// 人工复核表（#10）：条目在 scenario.json 的 review 里声明。
// 它是数据不是判据——读出来给报告渲染，形状写错也不让整次运行停下。
test('loadScenario 读出 review 声明，原样交给报告', (t) => {
  const root = tmpRepo(t);
  writeScenario(root, 's1', {
    prompt: 'x',
    review: [{ title: 'CHECKLIST 任务', expect: '标题、5 条检查事项' }],
  });
  assert.deepEqual(loadScenario(root, 's1').review, [{ title: 'CHECKLIST 任务', expect: '标题、5 条检查事项' }]);
});

test('没声明 review 时是 null，报告据此整节省略', (t) => {
  const root = tmpRepo(t);
  writeScenario(root, 's1', { prompt: 'x' });
  assert.equal(loadScenario(root, 's1').review, null);
});
