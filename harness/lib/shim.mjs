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

// PowerShell 同目录内优先解析 .ps1 而非 .cmd，而 @args 原样展开、不经 cmd 解析：
// 多行 --content 只有在 .ps1 这条入口上才保真（#13）。.cmd 供显式调用与非 PowerShell
// shell 使用；它不接执行策略的拒绝（AllSigned 下 .ps1 直接报错、不回落，见 ADR-0013）。
export function renderPs1Shim({ program, script, shimJs }) {
  return [
    `node "${shimJs}" "${program}" "${script}" @args`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
}
