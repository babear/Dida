import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import processAssert from './rule.mjs';

// 证据原件：一次真实运行的完整调用序列（脱敏后只留 argv 与 decision）。
// 测试与证据同源——规则改了而证据没变时，这条会红。
const EVIDENCE = path.join(import.meta.dirname, 'evidence.ndjson');

const P = '69abc459ebbdbd00000009f0';
const T = '6afbad50e4b05d0f5b91f1d1';

// 2026-11-17 真实记录里的两次关键调用，原样搬过来。
const WRONG_CREATE = {
  argv: ['task', 'create', '--project', P, '--title', '周末露营准备', '--content', '出发前把要带的东西和要做的事过一遍。',
    '--items', '["帐篷、睡袋、防潮垫","气罐与炉头","头灯和备用电池","两天的饮用水","防蚊液与常用药"]', '--json'],
  decision: 'allow',
};
const FIX_UPDATE = {
  argv: ['task', 'update', T, '--id', T, '--project', P,
    '--items', '帐篷、睡袋、防潮垫,气罐与炉头,头灯和备用电池,两天的饮用水,防蚊液与常用药', '--json'],
  decision: 'allow',
};
const READ = { argv: ['task', 'get', P, T, '--json'], decision: 'allow' };

const names = (results) => results.filter((r) => !r.ok).map((r) => r.name);

// 证据原件本身就是一次真实发生过的缺陷：这份日志在，这条规则就该红。
// 它是 process.mjs 的论据，也是这份规则的回归测试。
test('证据原件上的结论：这条规则命中', () => {
  const calls = fs.readFileSync(EVIDENCE, 'utf8').trim().split(String.fromCharCode(10))
    .map((line) => JSON.parse(line));
  const results = processAssert({ calls });
  assert.equal(results.filter((r) => !r.ok).length, 2, '两条都该命中：字符串数组建、update 补正');
  assert.match(results[0].actual, /第 8 条/);
  assert.match(results[1].actual, /第 11 条/);
});

// 手写的等价夹具：与上面那份证据同形，用来测规则本身而不依赖文件内容。
test('真实记录里的那一串动作被判为绕路', () => {
  const results = processAssert({ calls: [READ, WRONG_CREATE, READ, FIX_UPDATE, READ] });
  assert.equal(results.filter((r) => !r.ok).length, 2);
  assert.match(names(results)[0], /字符串数组/);
  assert.match(names(results)[1], /update --items/);
});

// 正确做法：一次用逗号分隔建对。这是 skill 该引导的形状，不能判红。
test('一次用逗号分隔建对时全绿', () => {
  const calls = [{
    argv: ['task', 'create', '--project', P, '--title', '周末露营准备',
      '--items', '帐篷、睡袋、防潮垫,气罐与炉头,头灯和备用电池', '--json'],
  }];
  assert.deepEqual(names(processAssert({ calls })), []);
});

// 对象数组是 spec 里另一种正确写法，同样不能判红。
test('一次用对象数组建对时全绿', () => {
  const calls = [{
    argv: ['task', 'create', '--project', P, '--title', 'x',
      '--items', '[{"title":"帐篷","status":0}]', '--json'],
  }];
  assert.deepEqual(names(processAssert({ calls })), []);
});

// 后续 update 改了别的字段（不碰 --items）不是「补正」，不该报。
test('update 不带 --items 不算补正', () => {
  const calls = [WRONG_CREATE, { argv: ['task', 'update', T, '--id', T, '--project', P, '--priority', '3'] }];
  const results = processAssert({ calls });
  assert.equal(results.filter((r) => !r.ok).length, 1, '只命中「用了字符串数组」那条');
  assert.match(names(results)[0], /字符串数组/);
});

// 规则只禁止错误动作，不要求走某条固定路径：先读后建、先建后读都一样。
test('先读文档再建、或建完再读，都不判红', () => {
  for (const calls of [
    [{ argv: ['task', 'create', '--help'] }, READ, { argv: ['task', 'create', '--items', 'a,b'] }],
    [{ argv: ['task', 'create', '--items', 'a,b'] }, READ, { argv: ['project', 'data', P] }],
  ]) {
    assert.deepEqual(names(processAssert({ calls })), []);
  }
});

// 坏行没有 argv，任何规则都判不了它——跳过，别崩。
test('日志里的坏行被跳过', () => {
  const calls = [{ unparseable: true, raw: 'not json' }, WRONG_CREATE, FIX_UPDATE];
  const results = processAssert({ calls });
  assert.equal(results.filter((r) => !r.ok).length, 2, '坏行不影响后面两条的序号与判定');
});

// 空日志：没有调用就没有可判的动作，一条都不该红。
test('空日志全绿', () => {
  assert.deepEqual(names(processAssert({ calls: [] })), []);
  assert.deepEqual(names(processAssert({})), [], 'calls 缺省时也不崩');
});

// --items 返回空字符串数组 [] 不算字符串数组（没有「逐项丢弃」可言）。
test('空数组字面量不判错', () => {
  assert.deepEqual(names(processAssert({ calls: [{ argv: ['task', 'create', '--items', '[]'] }] })), []);
});

// `--items=` 的等号写法也要认，否则换个写法就能绕过。
test('--items= 的等号写法同样命中', () => {
  const calls = [{ argv: ['task', 'create', '--items=["a","b"]'] }];
  assert.equal(names(processAssert({ calls })).length, 1);
});
