import fs from 'node:fs';
import path from 'node:path';

export function scenariosDir(repoRoot) {
  return path.join(repoRoot, 'skill-tests', 'scenarios');
}

export function listScenarios(repoRoot) {
  const dir = scenariosDir(repoRoot);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function loadScenario(repoRoot, id) {
  const dir = path.join(scenariosDir(repoRoot), id);
  const manifestPath = path.join(dir, 'scenario.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`scenario not found: ${id}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const materialsDir = path.join(dir, 'materials');
  return {
    id,
    dir,
    prompt: manifest.prompt,
    materialsDir: fs.existsSync(materialsDir) ? materialsDir : null,
  };
}
