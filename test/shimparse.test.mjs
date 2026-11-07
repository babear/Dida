import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { parseCmdShim, renderCmdShim } from '../harness/lib/shim.mjs';

const REAL_CMD = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@suibiji\\dida-cli\\dist\\index.js" %*',
].join('\r\n');

test('从 npm 生成的 .cmd 里解析出脚本路径；node 不存在时回退到当前进程', () => {
  const parsed = parseCmdShim(REAL_CMD, 'D:\\Program Files\\nodejs\\node_global');
  assert.equal(parsed.script, 'D:\\Program Files\\nodejs\\node_global\\node_modules\\@suibiji\\dida-cli\\dist\\index.js');
  // .cmd 里那个 %dp0%\node.exe 在本机不存在，实际要走 PATH 上的 node
  assert.equal(parsed.program, process.execPath);
});

test('.cmd 里有真实存在的 node.exe 时优先用它', () => {
  const text = [
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    '"%_prog%" "%dp0%\\index.js" %*',
  ].join('\r\n');
  const parsed = parseCmdShim(text, path.dirname(process.execPath));
  assert.equal(parsed.program, path.join(path.dirname(process.execPath), 'node.exe'));
});

test('解析不出入口时返回 null，调用方据此直接报错（不退回 CALL 转发）', () => {
  assert.equal(parseCmdShim('@ECHO off\r\nCALL "C:\\x\\dida.cmd" %*\r\n', 'C:\\x'), null);
});

test('shim 脚本以 node 调真入口，argv 原样透传，不经过 cmd 二次解析', () => {
  const text = renderCmdShim({
    program: 'D:\\Program Files\\nodejs\\node_global\\node.exe',
    script: 'D:\\Program Files\\nodejs\\node_global\\node_modules\\@suibiji\\dida-cli\\dist\\index.js',
    shimJs: 'C:\\sandbox\\bin\\dida-shim.mjs',
  });
  assert.match(text, /dida-shim\.mjs/);
  assert.match(text, /node\.exe/);
  assert.match(text, /dist\\index\.js/);
});
