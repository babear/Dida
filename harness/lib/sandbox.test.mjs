import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSandbox, renderGuardConfig, writeShim } from './sandbox.mjs';

const PROJECTS = ['69abc459ebbdbd00000009f0', '59f736cae4b060e424059e3b'];

// npm 生成的 .cmd 模板，parseCmdShim 要从中解析出 node 与脚本入口。
const REAL_CMD = [
  '@ECHO off',
  'SETLOCAL',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  'endLocal & "%_prog%"  "%dp0%\\node_modules\\@suibiji\\dida-cli\\dist\\index.js" %*',
].join('\r\n');

function sandboxDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('renderGuardConfig 生成可 import 的模块，内容是测试清单集合', () => {
  const source = renderGuardConfig(PROJECTS);
  assert.equal(source, `export const TEST_PROJECTS = ${JSON.stringify(PROJECTS)};\n`);
});

test('renderGuardConfig 拒绝缺集合，而不是生成 TEST_PROJECTS = undefined', () => {
  assert.throws(() => renderGuardConfig(undefined), /需要 testProjects/);
  assert.throws(() => renderGuardConfig(null), /需要 testProjects/);
});

// 这条锁的是生产烘焙路径：删掉 writeShim 里的 guard-config 写入，这条会红。
test('writeShim 把测试清单集合烘焙进 lib/guard-config.mjs', (t) => {
  const dir = sandboxDir(t);
  const realCmd = path.join(dir, 'dida.cmd');
  fs.writeFileSync(realCmd, REAL_CMD);

  writeShim(path.join(dir, 'bin'), realCmd, PROJECTS);

  const configPath = path.join(dir, 'bin', 'lib', 'guard-config.mjs');
  assert.ok(fs.existsSync(configPath), 'guard-config.mjs 必须被生成');
  assert.equal(fs.readFileSync(configPath, 'utf8'), renderGuardConfig(PROJECTS));
});

test('writeShim 复制 shim 依赖的模块，并生成 dida.cmd 与 dida.ps1 两份壳', (t) => {
  const dir = sandboxDir(t);
  const realCmd = path.join(dir, 'dida.cmd');
  fs.writeFileSync(realCmd, REAL_CMD);

  writeShim(path.join(dir, 'bin'), realCmd, PROJECTS);

  for (const name of ['calllog.mjs', 'created.mjs', 'guard.mjs']) {
    assert.ok(fs.existsSync(path.join(dir, 'bin', 'lib', name)), `缺少 ${name}`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'bin', 'dida-shim.mjs')));
  assert.match(fs.readFileSync(path.join(dir, 'bin', 'dida.cmd'), 'utf8'), /dida-shim\.mjs/);
  // PowerShell 同目录内优先 .ps1；缺了它多行 --content 会落回 .cmd 被截断（#13）
  assert.match(fs.readFileSync(path.join(dir, 'bin', 'dida.ps1'), 'utf8'), /dida-shim\.mjs/);
});

test('writeShim 缺集合时当场报错，不留下半成品配置', (t) => {
  const dir = sandboxDir(t);
  const realCmd = path.join(dir, 'dida.cmd');
  fs.writeFileSync(realCmd, REAL_CMD);

  assert.throws(() => writeShim(path.join(dir, 'bin'), realCmd, undefined), /需要 testProjects/);
  assert.equal(fs.existsSync(path.join(dir, 'bin', 'lib', 'guard-config.mjs')), false);
});

// createSandbox 此前零测试；materials 的复制路径（cpSync recursive）在别处也没被覆盖到。
function sandboxFixture(t) {
  const dir = sandboxDir(t);
  const realCmd = path.join(dir, 'dida.cmd');
  fs.writeFileSync(realCmd, REAL_CMD);

  const skillPath = path.join(dir, 'skill');
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# skill\n');

  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ env: {} }));

  const agentsSourcePath = path.join(dir, 'agents.json');
  fs.writeFileSync(agentsSourcePath, JSON.stringify({
    'dida-scenario': { description: 'd', prompt: 'p', tools: ['Read'] },
  }));

  const prevDidaCmd = process.env.DIDA_CMD;
  process.env.DIDA_CMD = realCmd;
  t.after(() => {
    if (prevDidaCmd === undefined) delete process.env.DIDA_CMD;
    else process.env.DIDA_CMD = prevDidaCmd;
  });

  // createSandbox 用 %TEMP%/run-<runId>，加随机后缀免得撞上一次残留、cpSync 把旧文件合并进来。
  // 清理由调用方在拿到 sandbox.root 之后注册，不在这里按 os.tmpdir() 重建路径——
  // 那样会把 createSandbox 的路径方案复制进测试，日后改了只会静默泄漏。
  const runId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return { dir, skillPath, agentsSourcePath, settingsPath, runId };
}

test('createSandbox 把 materials 连子目录一起复制进沙箱', (t) => {
  const { dir, skillPath, agentsSourcePath, settingsPath, runId } = sandboxFixture(t);

  const materialsDir = path.join(dir, 'materials-src');
  fs.mkdirSync(path.join(materialsDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(materialsDir, 'nested', 'deep.md'), 'deep');

  const sandbox = createSandbox({
    runId,
    skillPath,
    agentsSourcePath,
    scenario: { prompt: 'x', materialsDir },
    settingsPath,
    testProjects: PROJECTS,
  });
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  assert.equal(fs.readFileSync(path.join(sandbox.root, 'materials', 'nested', 'deep.md'), 'utf8'), 'deep');
});

test('createSandbox 没有 materials 时不建空目录', (t) => {
  const { skillPath, agentsSourcePath, settingsPath, runId } = sandboxFixture(t);

  const sandbox = createSandbox({
    runId,
    skillPath,
    agentsSourcePath,
    scenario: { prompt: 'x', materialsDir: null },
    settingsPath,
    testProjects: PROJECTS,
  });
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  assert.equal(fs.existsSync(path.join(sandbox.root, 'materials')), false);
});

// #13 的核心断言：PowerShell 在沙箱 bin 内解析 dida 时必须命中 .ps1，
// 且多行参数要经 @args 原样到达真 CLI。只断言生成文本不够——真正决定
// 保真与否的是 PowerShell 的解析优先级，那条只能端到端跑一次才知道。
// 假 CLI 把观测结果写文件：混在 stdout 里会被 PowerShell 自身的输出干扰，
// 也扛不住真 CLI 将来输出多行 JSON。
const PS_TEST = process.platform === 'win32' ? test : test.skip;

let cachedPowerShell;
function findPowerShell() {
  if (cachedPowerShell !== undefined) return cachedPowerShell;
  cachedPowerShell = null;
  for (const exe of ['pwsh.exe', 'powershell.exe']) {
    const found = spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (found.status === 0) { cachedPowerShell = exe; break; }
  }
  return cachedPowerShell;
}

// 某个 shell 是否可用；用于对 5.1 / 7 分别断言不同的已知行为。
function hasShell(exe) {
  return spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;
}

// PowerShell 里嵌路径：单引号串内的 ' 要写成 ''，否则 sandboxDir 含引号时会拼出坏脚本。
const psLiteral = (value) => `'${value.replace(/'/g, "''")}'`;

PS_TEST('PowerShell 命中 .ps1：多行 --content 经沙箱 shim 到达真 CLI 时仍是多行', (t) => {
  const shell = findPowerShell();
  if (!shell) return t.skip('本机没有 PowerShell');
  const dir = sandboxDir(t);
  const observed = path.join(dir, 'observed.json');
  const fakeCli = path.join(dir, 'fake-cli.mjs');
  fs.writeFileSync(
    fakeCli,
    `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  const realCmd = path.join(dir, 'dida.cmd');
  fs.writeFileSync(realCmd, [
    '@ECHO off',
    `"${process.execPath}" "${fakeCli}" %*`,
  ].join('\r\n'));

  const binDir = path.join(dir, 'bin');
  writeShim(binDir, realCmd, PROJECTS);
  assert.ok(fs.existsSync(path.join(binDir, 'dida.ps1')), 'bin 里必须有 dida.ps1，否则 PowerShell 只能命中 .cmd、多行会被截断');

  const body = 'line1\nline2\nline3';
  // 用 PS 变量承载多行正文，对应 skill 文档里把正文放进变量的写法
  const script = [
    `$env:PATH = ${psLiteral(binDir + ';')} + $env:PATH`,
    `$env:DIDA_CALL_LOG = ${psLiteral(path.join(dir, 'calls.ndjson'))}`,
    `$env:DIDA_CREATED_FILE = ${psLiteral(path.join(dir, 'created.ndjson'))}`,
    `$body = "line1\`nline2\`nline3"`,
    `(Get-Command dida).Source`,
    `dida task get inbox nonexistent --content $body`,
  ].join('; ');
  const result = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /[\\/]dida\.ps1/, 'PowerShell 必须命中 .ps1');
  assert.ok(fs.existsSync(observed), `真 CLI 未被调用；PowerShell stderr：${result.stderr}`);
  const argv = JSON.parse(fs.readFileSync(observed, 'utf8'));
  assert.equal(argv[argv.indexOf('--content') + 1], body, '多行正文必须原样到达真 CLI');
});

// Windows PowerShell 5.1 会吞掉空串参数：`--content ''` 到达 shim 时
// flag 与值一起消失，整条 argv 里再也找不到 `--content`。这会打穿 #8 规则 2
// （content 从非空变空）——判据看到的是"这次调用没传 content"，而不是"传了空的"。
// pwsh 7 不吞。修不了（是 5.1 的参数传递行为），但要让它在测试里显形。
function emptyContentValue(shell, t) {
  const dir = sandboxDir(t);
  const fakeCli = path.join(dir, 'fake-cli.mjs');
  const observed = path.join(dir, 'observed.json');
  fs.writeFileSync(
    fakeCli,
    `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  const realCmd = path.join(dir, 'dida.cmd');
  fs.writeFileSync(realCmd, ['@ECHO off', `"${process.execPath}" "${fakeCli}" %*`].join('\r\n'));
  const binDir = path.join(dir, 'bin');
  writeShim(binDir, realCmd, PROJECTS);

  const script = [
    `$env:PATH = ${psLiteral(binDir + ';')} + $env:PATH`,
    `$env:DIDA_CALL_LOG = ${psLiteral(path.join(dir, 'calls.ndjson'))}`,
    `$env:DIDA_CREATED_FILE = ${psLiteral(path.join(dir, 'created.ndjson'))}`,
    `$empty = ''`,
    // 用白名单里的清单 id，否则 shim 会以越界拒掉，假 CLI 根本不会启动
    `dida task update t1 --id t1 --project ${PROJECTS[0]} --content $empty`,
  ].join('; ');
  spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
  const argv = JSON.parse(fs.readFileSync(observed, 'utf8'));
  return argv[argv.indexOf('--content') + 1];
}

PS_TEST('空串 --content：pwsh 7 保真', (t) => {
  if (!hasShell('pwsh.exe')) return t.skip('本机没有 pwsh 7');
  assert.equal(emptyContentValue('pwsh.exe', t), '', 'pwsh 7 必须保住空串');
});

PS_TEST('空串 --content：5.1 连 flag 一起吞掉（已知局限，锁住以便变化时报警）', (t) => {
  if (!hasShell('powershell.exe')) return t.skip('本机没有 Windows PowerShell 5.1');
  // 5.1 的已知行为：`--content ''` 整个消失，argv 里 findIndex 得 -1、取到 undefined。
  // 锁在这里：哪天 5.1 变了这条会红，提醒重估 #8 规则 2 在 5.1 上的可判性。
  assert.equal(emptyContentValue('powershell.exe', t), undefined, '5.1 吞掉 --content 与其值；若不再如此请更新 ADR-0013 与本断言');
});
