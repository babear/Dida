import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELATIVE_EXE = path.join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

function npmPrefix() {
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync('cmd.exe', ['/d', '/c', 'npm prefix -g'], { encoding: 'utf8', windowsHide: true })
        : execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', windowsHide: true });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function fromGlobalNodeModules() {
  const prefix = npmPrefix();
  if (!prefix) return null;
  const candidate = path.join(prefix, RELATIVE_EXE);
  return fs.existsSync(candidate) ? candidate : null;
}

export function resolveClaudeExe() {
  if (process.env.CLAUDE_EXE) return process.env.CLAUDE_EXE;
  const candidates = [
    () => path.join(path.dirname(process.execPath), RELATIVE_EXE),
    () => path.join(path.dirname(process.execPath), '..', 'node_global', RELATIVE_EXE),
    fromGlobalNodeModules,
  ];
  for (const candidate of candidates) {
    const found = candidate();
    if (found && fs.existsSync(found)) return found;
  }
  throw new Error(
    'claude executable not found; set CLAUDE_EXE to the path of claude.exe',
  );
}

export function sanitizeEnv(parentEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (key.toUpperCase().startsWith('CLAUDE_')) continue;
    env[key] = value;
  }
  return env;
}

export const TOOL_FACE = ['Skill', 'PowerShell', 'Read', 'Glob', 'Grep', 'Write'];

export function buildSessionArgv({ prompt, agentsPath }) {
  return [
    '-p',
    prompt,
    '--agents',
    agentsPath,
    '--agent',
    'dida-scenario',
    '--allowedTools',
    TOOL_FACE.join(','),
    '--permission-mode',
    'dontAsk',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
  ];
}

export function runSession({ argv, cwd, env, tracePath, timeoutMs = 15 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tracePath, { flags: 'w' });
    const errChunks = [];
    const child = spawn(resolveClaudeExe(), argv, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => out.write(chunk));
    child.stderr.on('data', (chunk) => errChunks.push(chunk));

    child.on('error', (err) => {
      clearTimeout(timer);
      out.end(() => reject(err));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      out.end(() => {
        resolve({
          exitCode: code,
          timedOut,
          stderr: Buffer.concat(errChunks).toString('utf8'),
        });
      });
    });
  });
}

export function parseTrace(tracePath) {
  const text = fs.readFileSync(tracePath, 'utf8');
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      events.push({ type: 'unparseable', raw: line });
    }
  }
  return events;
}

export function summarizeTrace(events) {
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const result = events.find((event) => event.type === 'result');
  const toolCalls = [];
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
  }
  return {
    sessionId: init?.session_id ?? null,
    cwd: init?.cwd ?? null,
    tools: init?.tools ?? [],
    modelAlias: init?.model ?? null,
    toolCalls,
    resultText: result?.result ?? null,
    costUsd: result?.total_cost_usd ?? null,
    turns: result?.num_turns ?? null,
  };
}
