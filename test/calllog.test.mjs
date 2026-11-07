import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCallLog, writeCallLogEntry } from '../harness/lib/calllog.mjs';

test('调用日志每行是解析后的 argv 数组，不是命令字符串', () => {
  const entries = parseCallLog([
    JSON.stringify({ argv: ['task', 'create', '--title', '含 空格', '--content', '第一行\n第二行'] }),
  ].join('\n'));
  assert.deepEqual(entries[0].argv, ['task', 'create', '--title', '含 空格', '--content', '第一行\n第二行']);
});

test('argv 里的多行正文保持完整，不被截断成第一行', () => {
  const entries = parseCallLog(JSON.stringify({ argv: ['task', 'update', 'a', '--content', 'l1\r\nl2'] }));
  assert.equal(entries[0].argv.at(-1), 'l1\r\nl2');
});

test('空行被忽略，不入账', () => {
  const entries = parseCallLog('\n\n' + JSON.stringify({ argv: ['project', 'list'] }) + '\n\n');
  assert.equal(entries.length, 1);
});

test('坏行不被静默吞掉，单独标记出来', () => {
  const entries = parseCallLog('{"argv": ["a"]}\nnot json');
  assert.equal(entries.length, 2);
  assert.equal(entries[1].unparseable, true);
});

test('写入口把一条调用追加成一行 JSON', () => {
  const lines = [];
  writeCallLogEntry({ append: (line) => lines.push(line) }, { argv: ['task', 'get', 'inbox', 'x'] });
  assert.deepEqual(parseCallLog(lines.join('\n')).map((e) => e.argv), [['task', 'get', 'inbox', 'x']]);
});
