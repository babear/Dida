import test from 'node:test';
import assert from 'node:assert/strict';
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

test('writeShim 复制 shim 依赖的模块，并生成 dida.cmd 壳', (t) => {
  const dir = sandboxDir(t);
  const realCmd = path.join(dir, 'dida.cmd');
  fs.writeFileSync(realCmd, REAL_CMD);

  writeShim(path.join(dir, 'bin'), realCmd, PROJECTS);

  for (const name of ['calllog.mjs', 'created.mjs', 'guard.mjs']) {
    assert.ok(fs.existsSync(path.join(dir, 'bin', 'lib', name)), `缺少 ${name}`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'bin', 'dida-shim.mjs')));
  assert.match(fs.readFileSync(path.join(dir, 'bin', 'dida.cmd'), 'utf8'), /dida-shim\.mjs/);
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
