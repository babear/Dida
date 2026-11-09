import fs from 'node:fs';
import path from 'node:path';

// `dida task create` 默认输出 "已创建: <title>" 后跟 "ID: <id>"；--json 时输出整个任务对象。
// 两种形态都要认，否则打开 --json 的那次会话会漏记。
const PLAIN_ID = /^ID:\s*([0-9a-f]{24})\s*$/im;
const HEX_ID = /^[0-9a-f]{24}$/;

function isCreateCall(argv) {
  return argv?.[0] === 'task' && argv?.[1] === 'create';
}

// --project p1 与 --project=p1 都要认：agent 两种写法都会用。
function flagValue(argv, flag) {
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1) || null;
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
      // JSON 分支不信任 id 的形状：脏值进账本会让清场发错命令。
      if (typeof parsed?.id === 'string' && HEX_ID.test(parsed.id)) return parsed.id;
    } catch {
      return null;
    }
  }
  return null;
}

// 账本是 NDJSON：一行一条，追加写入。这样并发 create 不会互相覆盖，
// 进程被 kill 在写入途中最多留下一行残片，跳过后其余记录仍然可读。
export function readCreated(file) {
  if (!fs.existsSync(file)) return [];
  const entries = [];
  const seen = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry?.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

export function recordCreated(file, { argv, stdout, exitCode = 0 }) {
  if (exitCode !== 0) return null;
  if (!isCreateCall(argv)) return null;
  const id = taskIdFromCreateOutput(stdout);
  if (!id) return null;
  const entry = { id, projectId: flagValue(argv, '--project'), title: flagValue(argv, '--title') };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return id;
}
