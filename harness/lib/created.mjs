import fs from 'node:fs';
import path from 'node:path';

// `dida task create` 默认输出 "已创建: <title>" 后跟 "ID: <id>"；--json 时输出整个任务对象。
// 两种形态都要认，否则打开 --json 的那次会话会漏记。
const PLAIN_ID = /^ID:\s*([0-9a-f]{24})\s*$/im;

function isCreateCall(argv) {
  return argv?.[0] === 'task' && argv?.[1] === 'create';
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
}

export function taskIdFromCreateOutput(stdout) {
  const plain = PLAIN_ID.exec(stdout ?? '');
  if (plain) return plain[1];
  const trimmed = (stdout ?? '').trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.id === 'string') return parsed.id;
    } catch {
      return null;
    }
  }
  return null;
}

export function readCreated(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error(`${file} 不是合法 JSON；清场依赖它，损坏时必须停手而不是当作空清单`);
  }
}

function writeCreated(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
}

export function recordCreated(file, { argv, stdout, exitCode = 0 }) {
  if (exitCode !== 0) return null;
  if (!isCreateCall(argv)) return null;
  const id = taskIdFromCreateOutput(stdout);
  if (!id) return null;
  const entries = readCreated(file);
  if (entries.some((entry) => entry.id === id)) return id;
  entries.push({
    id,
    projectId: flagValue(argv, '--project'),
    title: flagValue(argv, '--title'),
  });
  writeCreated(file, entries);
  return id;
}

export function removeCreated(file, id) {
  writeCreated(file, readCreated(file).filter((entry) => entry.id !== id));
}
