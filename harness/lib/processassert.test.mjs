import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateProcessRules, PROCESS_RULES, staleRuleSources } from './processassert.mjs';

// 规则表凭证据准入（ADR-0005）：仓库里还没有一次真实会话确认过缺陷动作，
// 所以表是空的。这条不是「还没写」，是「现在一条都不该有」。
test('规则表当前为空：没有真实会话证据，就不登记规则', () => {
  assert.deepEqual(PROCESS_RULES, []);
});

test('空规则表对任何调用日志都通过，一条失败项都不产出', () => {
  const out = evaluateProcessRules([
    { argv: ['task', 'create', '--items', 'x'] },
    { argv: ['task', 'delete', 'p1', 't1'] },
  ]);
  assert.equal(out.ok, true);
  assert.deepEqual(out.results, []);
});

// 下面用夹具规则验机制本身：判定链在规则表填上之后要走的路，现在就得通。
function fixtureRule(overrides = {}) {
  return {
    id: 'fixture',
    desc: '不存在删除之后再建',
    discoveredBy: 'some-scenario',
    check: (entries) => {
      const hit = entries.find((entry) => entry.argv[1] === 'delete');
      return hit ? { ok: false, actual: `第 ${hit.index + 1} 条是 delete` } : { ok: true, actual: '没有出现' };
    },
    ...overrides,
  };
}

test('规则命中时产出与结局断言同形的失败项，名字取规则自身的说明', () => {
  const out = evaluateProcessRules(
    [{ argv: ['task', 'create'] }, { argv: ['task', 'delete', 'p1', 't1'] }],
    [fixtureRule()],
  );
  assert.equal(out.ok, false);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[0].name, '不存在删除之后再建');
  assert.match(out.results[0].actual, /第 2 条/);
});

test('规则没命中时通过，actual 是规则自己给的「没有出现」', () => {
  const out = evaluateProcessRules([{ argv: ['task', 'get'] }], [fixtureRule()]);
  assert.equal(out.ok, true);
  assert.equal(out.results[0].ok, true);
});

// 判据只认调用日志里能解析的条目：坏行没有 argv，任何规则都无法据此判断。
test('坏行不进规则，且不影响其余条目的序号', () => {
  let seen;
  const rule = fixtureRule({
    check: (entries) => { seen = entries.map((entry) => entry.argv); return { ok: true }; },
  });
  evaluateProcessRules([
    { argv: ['task', 'get'] },
    { unparseable: true, raw: 'not json' },
    { argv: ['task', 'delete', 'p1', 't1'] },
  ], [rule]);
  assert.deepEqual(seen, [['task', 'get'], ['task', 'delete', 'p1', 't1']]);
});

// 规则是我们自己的代码，抛异常是 harness 的 bug。它不能把判定链带走——
// 那时会话已结束、manifest 还没落盘、清场还没跑，任务会留在真实清单里。
test('规则抛异常折成 threw 标记，不向上抛', () => {
  const out = evaluateProcessRules([{ argv: ['task', 'get'] }], [
    fixtureRule({ check: () => { throw new Error('规则自己写错了'); } }),
  ]);
  assert.equal(out.ok, false);
  assert.equal(out.threw, true);
  assert.match(out.results[0].actual, /规则自己写错了/);
});

// 规则的来源用例是可追溯的：删掉 scenario 之后，规则会失去它当初的证据。
test('来源用例仍在时不算失效', () => {
  assert.deepEqual(staleRuleSources([fixtureRule()], ['some-scenario', 'other']), []);
});

test('来源用例不在了时点名这条规则', () => {
  const stale = staleRuleSources([fixtureRule(), fixtureRule({ id: 'kept', discoveredBy: 'other' })], ['other']);
  assert.deepEqual(stale.map((rule) => rule.id), ['fixture']);
});

test('没有来源声称的规则也算失效——它拿不出证据', () => {
  assert.deepEqual(staleRuleSources([fixtureRule({ discoveredBy: undefined })], ['x']).map((r) => r.id), ['fixture']);
});
