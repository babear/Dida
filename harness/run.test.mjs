import test from 'node:test';
import assert from 'node:assert/strict';

import { hasCleanupProblem } from './run.mjs';

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
