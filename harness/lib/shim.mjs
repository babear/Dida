import fs from 'node:fs';

const WRITE_SUBCOMMANDS = new Set([
  'create',
  'update',
  'delete',
  'move',
  'complete',
  'complete-batch',
  'assign',
  'unassign',
  'comment:add',
  'comment:delete',
]);

export function classify(argv) {
  const [group, sub] = argv ?? [];
  if (!group || !sub) return 'read';
  if (sub === 'comment' && argv[2] === 'add') return 'write';
  if (sub === 'comment' && argv[2] === 'delete') return 'write';
  return WRITE_SUBCOMMANDS.has(sub) ? 'write' : 'read';
}

export function forwardTarget({ realDidaCmd }) {
  if (!realDidaCmd) {
    throw new Error('真 dida.cmd 路径缺失；转发不能降级成自递归');
  }
  return realDidaCmd;
}

// npm 生成的 .cmd 里始终有 `IF EXIST "%dp0%\node.exe"` 分支，但那个文件通常不存在。
// 真正生效的是 IF 块里的 `SET _prog=`：先取它，且只在文件确实存在时才用。
const PROG_SET = /SET\s+"?_prog=([^"\r\n]+)"?/gi;
const SCRIPT_ARG = /"([^"]*\.(?:js|cjs|mjs))"\s+%\*/i;

export function parseCmdShim(text, cmdDir) {
  const unquote = (value) => value.replace(/%dp0%/gi, cmdDir);
  const script = SCRIPT_ARG.exec(text)?.[1];
  if (!script) return null;

  // 依次看每个 SET _prog=，取第一个在磁盘上真实存在的（node.exe 分支不存在时会落到 node）。
  const candidates = [...text.matchAll(PROG_SET)].map((m) => unquote(m[1].trim()));
  const program = candidates.find((candidate) => fs.existsSync(candidate)) ?? process.execPath;
  return { program, script: unquote(script) };
}

export function renderCmdShim({ program, script, shimJs }) {
  return [
    '@ECHO off',
    `node "${shimJs}" "${program}" "${script}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}
