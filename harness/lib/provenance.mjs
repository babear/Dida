import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function gitState(repoRoot) {
  const read = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  try {
    return {
      rev: read(['rev-parse', 'HEAD']),
      dirty: read(['status', '--porcelain']).length > 0,
    };
  } catch {
    return { rev: null, dirty: null };
  }
}

export function modelInfo(env) {
  const pick = (key) => env[key] ?? null;
  const aliases = ['SONNET', 'OPUS', 'HAIKU', 'FABLE'];
  return {
    requested_alias: null,
    resolved_model: pick('ANTHROPIC_DEFAULT_SONNET_MODEL'),
    resolved_model_name: pick('ANTHROPIC_DEFAULT_SONNET_MODEL_NAME'),
    provider: pick('ANTHROPIC_BASE_URL'),
    alias_mapping: Object.fromEntries(
      aliases.map((alias) => [
        alias.toLowerCase(),
        {
          model: pick(`ANTHROPIC_DEFAULT_${alias}_MODEL`),
          name: pick(`ANTHROPIC_DEFAULT_${alias}_MODEL_NAME`),
        },
      ]),
    ),
  };
}

export function runId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

export function ensureRunsDir(repoRoot) {
  const runsDir = path.join(repoRoot, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  return runsDir;
}

export function defaultSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}
