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

export function sanitizeEnv(parentEnv) {
  const env = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    // 无下划线的 CLAUDECODE 也算 Claude Code 的标记变量，不能只按 CLAUDE_ 前缀判
    if (key.toUpperCase().startsWith('CLAUDE')) continue;
    env[key] = value;
  }
  return env;
}

export const AGENT_NAME = 'dida-scenario';

const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

// 工具面只有 agents.json 一处定义，--allowedTools 从它派生，避免两份字面量各自漂移
export function toolFaceOf(agentsPath) {
  const agents = JSON.parse(fs.readFileSync(agentsPath, 'utf8'));
  const agent = agents[AGENT_NAME];
  if (!agent?.tools?.length) {
    throw new Error(`${agentsPath} 里没有 ${AGENT_NAME} 的 tools`);
  }
  return agent.tools;
}

export function buildSessionArgv({ prompt, agentsPath }) {
  return [
    '-p',
    prompt,
    '--agents',
    agentsPath,
    '--agent',
    AGENT_NAME,
    '--allowedTools',
    toolFaceOf(agentsPath).join(','),
    '--permission-mode',
    'dontAsk',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
  ];
}

// 会话是否正常收尾。终态不可归因时断言不评、清场延后、沙箱保留，三处都问这个。
export function sessionCompleted(session) {
  return session.exitCode === 0 && !session.timedOut;
}

export function runSession({ argv, cwd, env, transcriptPath }) {  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(transcriptPath, { flags: 'w' });
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
    }, SESSION_TIMEOUT_MS);

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

export function parseTranscript(transcriptPath) {
  const text = fs.readFileSync(transcriptPath, 'utf8');
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

export function summarizeTranscript(events) {
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
    tools: init?.tools ?? [],
    modelAlias: init?.model ?? null,
    toolCalls,
    costUsd: result?.total_cost_usd ?? null,
    turns: result?.num_turns ?? null,
  };
}
