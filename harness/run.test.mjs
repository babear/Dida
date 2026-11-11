import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hasCleanupProblem, writeUnusableRun } from './run.mjs';

function tmpRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cleanupFixture(overrides = {}) {
  return { deleted: [], failed: [], remaining: [], mismatched: [], ...overrides };
}

test('清场全部成功时不算问题', () => {
  assert.equal(hasCleanupProblem(cleanupFixture({ deleted: ['a'] })), false);
});

test('账本与实况的清单不一致但已按实况删掉，不算问题（ADR-0010 定性为合法）', () => {
  const cleanup = cleanupFixture({
    deleted: ['a'],
    mismatched: [{ id: 'a', recordedAt: 'p1', actual: 'p2' }],
  });
  assert.equal(hasCleanupProblem(cleanup), false);
});

test('删完仍在清单里算问题', () => {
  assert.equal(hasCleanupProblem(cleanupFixture({ remaining: ['a'] })), true);
});

test('删除失败算问题', () => {
  assert.equal(hasCleanupProblem(cleanupFixture({ failed: [{ id: 'a' }] })), true);
});

test('清场读账本出错算问题', () => {
  assert.equal(hasCleanupProblem(cleanupFixture({ error: '账本损坏' })), true);
});

test('缺断言时也落一份报告，报告里写明是「缺断言」而不是「断言未通过」', (t) => {
  const root = tmpRepo(t);
  const { runDir } = writeUnusableRun(root, 's1', {
    skillPath: 'skills/dida-cli',
    status: 'missing',
    detail: '缺 skill-tests/scenarios/s1/assert.mjs',
  });

  const report = fs.readFileSync(path.join(runDir, 'report.md'), 'utf8');
  assert.match(report, /缺断言/);
  assert.match(report, /用例配置错误/);
  assert.doesNotMatch(report, /结局断言 未通过/);
  // 没开会话，报告里不该出现会话/模型/清场小节——那会让读者以为跑过。
  assert.doesNotMatch(report, /## 会话/);
  assert.doesNotMatch(report, /## 模型/);
  assert.doesNotMatch(report, /跑了一次真实会话/);

  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.assertion.status, 'missing');
  assert.equal(manifest.scenario, 's1');
});

test('断言模块加载失败同样落报告，与缺断言分开写', (t) => {
  const root = tmpRepo(t);
  const { runDir } = writeUnusableRun(root, 's1', {
    skillPath: 'skills/dida-cli',
    status: 'broken',
    detail: 'assert.mjs 没有默认导出的函数',
  });

  const report = fs.readFileSync(path.join(runDir, 'report.md'), 'utf8');
  assert.match(report, /断言模块加载失败/);
  assert.match(report, /assert\.mjs 没有默认导出的函数/);
  assert.doesNotMatch(report, /缺断言/);
});

test('用例没跑起来时不建沙箱、不开会话：manifest 里没有会话记录', (t) => {
  const root = tmpRepo(t);
  const { runDir } = writeUnusableRun(root, 's1', { skillPath: 'skills/dida-cli', status: 'missing', detail: 'x' });
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.created.length, 0);
  assert.deepEqual(manifest.session, {});
});
