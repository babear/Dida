import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listScenarios, loadScenario, scenariosDir } from './scenario.mjs';

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-test-'));
}

function writeScenario(repoRoot, id, manifest, materials) {
  const dir = path.join(repoRoot, 'skill-tests', 'scenarios', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(manifest));
  if (materials) {
    fs.mkdirSync(path.join(dir, 'materials'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'materials', 'plan.md'), materials);
  }
  return dir;
}

test('scenariosDir 指向 skill-tests/scenarios，不是仓库根的 scenarios', () => {
  assert.equal(scenariosDir('/repo'), path.join('/repo', 'skill-tests', 'scenarios'));
});

test('目录不存在时 listScenarios 返回空数组而不是抛错', () => {
  assert.deepEqual(listScenarios(tmpRepo()), []);
});

test('listScenarios 只列目录、按名排序，忽略散落文件', () => {
  const root = tmpRepo();
  writeScenario(root, 'z-last', { prompt: 'x' });
  writeScenario(root, 'a-first', { prompt: 'x' });
  fs.writeFileSync(path.join(scenariosDir(root), 'README.md'), 'not a scenario');
  assert.deepEqual(listScenarios(root), ['a-first', 'z-last']);
});

test('loadScenario 读出 prompt 与 materials 目录', () => {
  const root = tmpRepo();
  writeScenario(root, 's1', { prompt: '请建一条任务' }, '# 计划\n');
  const loaded = loadScenario(root, 's1');
  assert.equal(loaded.id, 's1');
  assert.equal(loaded.prompt, '请建一条任务');
  assert.ok(loaded.materialsDir && fs.existsSync(loaded.materialsDir));
});

test('没有 materials 目录时 materialsDir 为 null', () => {
  const root = tmpRepo();
  writeScenario(root, 's1', { prompt: 'x' });
  assert.equal(loadScenario(root, 's1').materialsDir, null);
});

test('找不到 scenario 时报错而不是返回半成品', () => {
  const root = tmpRepo();
  assert.throws(() => loadScenario(root, 'missing'), /scenario not found: missing/);
});

test('仓库根的 scenarios/ 不被读取——目录搬走之后旧路径不能再生效', () => {
  const root = tmpRepo();
  fs.mkdirSync(path.join(root, 'scenarios', 'legacy'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scenarios', 'legacy', 'scenario.json'),
    JSON.stringify({ prompt: 'x' }),
  );
  assert.deepEqual(listScenarios(root), []);
});
