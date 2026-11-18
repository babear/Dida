import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveRun } from './replay.mjs';

function tmpRepo(t, names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of names) fs.mkdirSync(path.join(dir, name), { recursive: true });
  return dir;
}

test('runId 写全时精确命中', (t) => {
  const runs = tmpRepo(t, ['2026-11-17T01-25-37-814Z-7ed8fa', '2026-11-17T01-39-06-786Z-c2fb33']);
  assert.equal(path.basename(resolveRun(runs, '2026-11-17T01-25-37-814Z-7ed8fa')), '2026-11-17T01-25-37-814Z-7ed8fa');
});

// 真跑出来的 id 很长，手输总是截断；前缀唯一时放行。
test('前缀唯一时按前缀命中', (t) => {
  const runs = tmpRepo(t, ['2026-11-17T01-25-37-814Z-7ed8fa', '2026-11-17T01-39-06-786Z-c2fb33']);
  assert.equal(path.basename(resolveRun(runs, '2026-11-17T01-25-37')), '2026-11-17T01-25-37-814Z-7ed8fa');
});

// 命中多条时必须报错而不是随便挑一条：回放的是证据，挑错了结论就是假的。
test('前缀命中多条时报错，并列出候选', (t) => {
  const runs = tmpRepo(t, ['2026-11-17T01-25-37-814Z-aaaaaa', '2026-11-17T01-25-37-900Z-bbbbbb']);
  assert.throws(
    () => resolveRun(runs, '2026-11-17T01-25-37'),
    (error) => /命中 2 条/.test(error.message) && /aaaaaa/.test(error.message) && /bbbbbb/.test(error.message),
  );
});

test('找不到时说明找不到，不返回一个猜的路径', (t) => {
  const runs = tmpRepo(t, ['a-run']);
  assert.throws(() => resolveRun(runs, 'nope'), /找不到 run/);
});

test('runs 目录不存在时报错', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => resolveRun(path.join(dir, 'runs'), 'x'), /runs 目录不存在/);
});

// 精确命中优先于前缀命中：一条 runId 恰好是另一条的前缀时，写全就该拿那条。
test('写全的 runId 优先于前缀命中', (t) => {
  const runs = tmpRepo(t, ['abc', 'abcdef']);
  assert.equal(path.basename(resolveRun(runs, 'abc')), 'abc');
});
