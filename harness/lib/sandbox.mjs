import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TOOL_FACE } from './session.mjs';

export const SKILL_NAME = 'dida-cli';

function listFiles(dir, base = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full, base));
    else if (entry.isFile()) files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files;
}

export function fingerprintDir(dir) {
  const hash = createHash('sha256');
  const files = listFiles(dir);
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, rel)));
    hash.update('\0');
  }
  return { sha256: hash.digest('hex'), files: files.length };
}

export function pickAnthropicEnv(settings) {
  const env = settings?.env ?? {};
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.startsWith('ANTHROPIC_')),
  );
}

export function buildAgentDefinition() {
  return {
    'dida-scenario': {
      description: '执行一条评测 scenario 的一次性被测 agent',
      prompt: '你是被测 agent。按用户的要求使用你可用的工具完成任务。',
      tools: TOOL_FACE,
    },
  };
}

export const CALLER_MARKER_HEADING = '调用方标记';

export function callerMarker(runId) {
  return `HARNESS-CALLER-MARKER-${runId}`;
}

export function appendCallerMarker(skillDir, runId) {
  const skillFile = path.join(skillDir, 'SKILL.md');
  fs.appendFileSync(skillFile, `\n## ${CALLER_MARKER_HEADING}\n\n${callerMarker(runId)}\n`);
}

export function resolveRealDidaCmd(searchPath = process.env.PATH ?? '') {
  if (process.env.DIDA_CMD) return process.env.DIDA_CMD;
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'dida.cmd');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function writePassthroughShim(binDir, realDidaCmd) {
  if (!realDidaCmd) {
    throw new Error('dida.cmd not found on PATH; set DIDA_CMD to the real dida.cmd');
  }
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'dida.cmd'),
    `@ECHO off\r\nCALL "${realDidaCmd}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
  );
}

export function createSandbox({ runId, skillPath, scenario, settingsPath, tempRoot = os.tmpdir() }) {
  const root = path.join(tempRoot, `run-${runId}`);
  const configDir = path.join(root, '.claude');
  const binDir = path.join(root, 'bin');
  const sandboxSkillPath = path.join(configDir, 'skills', SKILL_NAME);

  fs.mkdirSync(configDir, { recursive: true });
  fs.cpSync(skillPath, sandboxSkillPath, { recursive: true });

  // 指纹必须在追加标记之前算，否则每次运行都不同，失去"这是哪一份 skill"的凭据意义
  const skillFingerprint = fingerprintDir(sandboxSkillPath);
  appendCallerMarker(sandboxSkillPath, runId);

  const sourceSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const anthropicEnv = pickAnthropicEnv(sourceSettings);
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({ env: anthropicEnv }, null, 2),
  );

  const agentsPath = path.join(root, 'agents.json');
  fs.writeFileSync(agentsPath, JSON.stringify(buildAgentDefinition(), null, 2));

  writePassthroughShim(binDir, resolveRealDidaCmd());

  if (scenario.materialsDir) {
    fs.cpSync(scenario.materialsDir, path.join(root, 'materials'), { recursive: true });
  }

  return {
    root,
    configDir,
    binDir,
    skillPath: sandboxSkillPath,
    agentsPath,
    callerMarker: callerMarker(runId),
    skillFingerprint,
    anthropicEnv,
  };
}
