import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolFaceOf } from './session.mjs';
import { parseCmdShim, renderCmdShim } from './shim.mjs';

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

// shim 不是再转一次 .cmd：那样 %* 会把多行 --content 截断成第一行。
// 改为让 .cmd 只是启动 node 记账脚本，由它 spawn 真 CLI 的入口，argv 不经过 cmd 二次解析。
const SHIM_SCRIPT_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dida-shim.mjs');
const SHIM_LIB_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

function writeShim(binDir, realDidaCmd) {
  if (!realDidaCmd) {
    throw new Error('dida.cmd not found on PATH; set DIDA_CMD to the real dida.cmd');
  }
  const source = fs.readFileSync(realDidaCmd, 'utf8');
  const parsed = parseCmdShim(source, path.dirname(realDidaCmd));
  if (!parsed) {
    throw new Error(`无法从 ${realDidaCmd} 解析出 node 与脚本入口；shim 需要直接 spawn 真 CLI`);
  }

  fs.mkdirSync(binDir, { recursive: true });
  const shimJs = path.join(binDir, 'dida-shim.mjs');
  fs.copyFileSync(SHIM_SCRIPT_SOURCE, shimJs);
  // shim 只依赖这几个模块；整目录复制会把 run.mjs 无关的东西也带进沙箱。
  const libDir = path.join(binDir, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  for (const name of ['calllog.mjs', 'created.mjs', 'guard.mjs', 'projects.mjs', 'shim.mjs']) {
    fs.copyFileSync(path.join(SHIM_LIB_SOURCE, name), path.join(libDir, name));
  }
  fs.writeFileSync(
    path.join(binDir, 'dida.cmd'),
    renderCmdShim({ program: parsed.program, script: parsed.script, shimJs }),
  );
  return { program: parsed.program, script: parsed.script };
}

export function createSandbox({ runId, skillPath, agentsSourcePath, scenario, settingsPath }) {
  const root = path.join(os.tmpdir(), `run-${runId}`);
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
  fs.copyFileSync(agentsSourcePath, agentsPath);
  // 定义文件是唯一事实源，坏掉要在建沙箱时就报，而不是等 claude -p 起来后从 stderr 里猜
  toolFaceOf(agentsPath);

  const shim = writeShim(binDir, resolveRealDidaCmd());

  if (scenario.materialsDir) {
    fs.cpSync(scenario.materialsDir, path.join(root, 'materials'), { recursive: true });
  }

  return {
    root,
    configDir,
    binDir,
    agentsPath,
    shim,
    callerMarker: callerMarker(runId),
    skillFingerprint,
    anthropicEnv,
  };
}
