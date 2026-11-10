import fs from 'node:fs';

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
