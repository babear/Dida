import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────
// 三条命令各自跑什么，必须分清（#9）：
//   test:harness    → harness 自己的单元测试，不烧 API
//   test:scenarios  → 用例目录里的断言自检，不烧 API
//   test            → 先跑前两个，绿了再跑真实会话（烧 API）
// 前两个混在一起会让「断言逻辑本身有错时还去烧钱」这件事重新发生。
// ─────────────────────────────────────────────────────────────────────────

const scripts = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
).scripts;

test('test:harness 只跑 harness 自己的测试，不碰 skill-tests', () => {
  assert.match(scripts['test:harness'], /harness\//);
  assert.doesNotMatch(scripts['test:harness'], /skill-tests/);
});

test('test:scenarios 只跑用例目录里的断言自检', () => {
  assert.match(scripts['test:scenarios'], /skill-tests/);
  assert.doesNotMatch(scripts['test:scenarios'], /harness\//);
});

test('npm test 先跑两个不烧 API 的，绿了才跑真实会话', () => {
  const script = scripts.test;
  const harnessAt = script.indexOf('test:harness');
  const scenariosAt = script.indexOf('test:scenarios');
  const liveAt = script.indexOf('harness/run.mjs');
  assert.ok(harnessAt >= 0, 'npm test 要包含 test:harness');
  assert.ok(scenariosAt >= 0, 'npm test 要包含 test:scenarios');
  assert.ok(liveAt >= 0, 'npm test 要跑真实会话');
  assert.ok(harnessAt < liveAt, 'test:harness 必须在真实会话之前');
  assert.ok(scenariosAt < liveAt, 'test:scenarios 必须在真实会话之前');
  // 用 && 而不是 ;：前一步红了就不该继续往下烧钱。
  assert.doesNotMatch(script, /;/, '必须用 && 串联，前一步失败就停');
});
