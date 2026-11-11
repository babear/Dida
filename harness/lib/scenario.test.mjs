import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listScenarios, loadScenario, scenariosDir } from './scenario.mjs';

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

test('materials 源目录里的子目录结构原样交给沙箱复制', (t) => {
  const root = tmpRepo(t);
  const dir = writeScenario(root, 's1', { prompt: 'x' });
  fs.mkdirSync(path.join(dir, 'materials', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'materials', 'nested', 'deep.md'), 'deep');
  const loaded = loadScenario(root, 's1');
  assert.equal(loaded.materialsDir, path.join(dir, 'materials'));
  assert.ok(fs.existsSync(path.join(loaded.materialsDir, 'nested', 'deep.md')));
});
