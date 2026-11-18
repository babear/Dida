import fs from 'node:fs';
import path from 'node:path';

export function scenariosDir(repoRoot) {
  return path.join(repoRoot, 'skill-tests', 'scenarios');
}

export function probesDir(repoRoot) {
  return path.join(repoRoot, 'skill-tests', 'probes');
}

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// 全量运行只扫 scenarios/：探针不计入回归网（ADR-0015）。
export function listScenarios(repoRoot) {
  return listDirs(scenariosDir(repoRoot));
}

export function listProbes(repoRoot) {
  return listDirs(probesDir(repoRoot));
}

// 两条路径共用一个查找入口，`kind` 是编排层唯一要认的岔路标记（ADR-0015）。
// 同名时正式用例优先：否则「以为在测正式用例，实际跑的是探针」。
export function loadScenario(repoRoot, id) {
  const found = [
    { dir: path.join(scenariosDir(repoRoot), id), kind: 'scenario' },
    { dir: path.join(probesDir(repoRoot), id), kind: 'probe' },
  ].find((candidate) => fs.existsSync(path.join(candidate.dir, 'scenario.json')));
  if (!found) {
    throw new Error(`scenario not found: ${id}`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(found.dir, 'scenario.json'), 'utf8'));
  const materialsDir = path.join(found.dir, 'materials');
  return {
    id,
    dir: found.dir,
    kind: found.kind,
    // 探针目录里的 assert.mjs 不执行，但调用方要能据此提示「未被使用」。
    hasAssert: fs.existsSync(path.join(found.dir, 'assert.mjs')),
    // 过程断言是可选件：没写就是不判过程这一面，报告里写明「未判」。
    hasProcessAssert: fs.existsSync(path.join(found.dir, 'process.mjs')),
    // 预设可选：没有它时行为不变，编排层按 null 走原路（#19）。
    hasPreset: fs.existsSync(path.join(found.dir, 'preset.mjs')),
    prompt: manifest.prompt,
    materialsDir: fs.existsSync(materialsDir) ? materialsDir : null,
  };
}
