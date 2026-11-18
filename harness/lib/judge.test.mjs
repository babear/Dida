import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildJudgePrompt,
  DIMENSIONS,
  judgeRun,
  judgeTextOf,
  parseJudgement,
  resolveReview,
  reviewEntriesOf,
} from './judge.mjs';
import { needsJudgement } from '../run.mjs';

// ─────────────────────────────────────────────────────────────────────────
// 判定 agent 不参与判定（#10）：它的输出只写到报告里，退出码与 status 都不看它。
// 所以这一层的每一个失败都要折成「判定缺失」，绝不抛——抛了会让一次已经跑完的
// 会话连判定结论都落不下。
// ─────────────────────────────────────────────────────────────────────────

const TRACE = 'C:\\runs\\x\\trace.ndjson';
const CALLS = 'C:\\runs\\x\\calls.ndjson';

test('prompt 给出轨迹与调用日志的路径，判定 agent 才读得到依据', () => {
  const prompt = buildJudgePrompt({
    scenario: 's1',
    prompt: '把 materials/plan.md 建成检查清单',
    tracePath: TRACE,
    callsPath: CALLS,
    created: [{ id: 'aaaa00000000000000000001', title: '装修准备' }],
  });
  assert.match(prompt, /C:\\runs\\x\\trace\.ndjson/);
  assert.match(prompt, /C:\\runs\\x\\calls\.ndjson/);
  assert.match(prompt, /把 materials\/plan\.md 建成检查清单/);
  assert.match(prompt, /aaaa00000000000000000001/);
});

// 三个维度是 AC 的点名项。dimensions 少一个，报告那段就不算「覆盖三面」。
test('prompt 点名三个维度，且与 DIMENSIONS 同源', () => {
  const prompt = buildJudgePrompt({ scenario: 's1', prompt: 'x', tracePath: TRACE, callsPath: CALLS });
  assert.equal(DIMENSIONS.length, 3);
  for (const dimension of DIMENSIONS) assert.match(prompt, new RegExp(dimension.label));
  assert.match(prompt, /绕路/);
  assert.match(prompt, /冗余操作/);
  assert.match(prompt, /先读后改/);
});

test('没建出任务时 prompt 说清楚，不留一张空表', () => {
  const prompt = buildJudgePrompt({ scenario: 's1', prompt: 'x', tracePath: TRACE, callsPath: CALLS, created: [] });
  assert.match(prompt, /没有建出任务/);
});

test('解析判定输出：三个标题各切一节，正文原样留下', () => {
  const parsed = parseJudgement([
    '## 绕路',
    '第 3 条先建了 CHECKLIST 再删掉。',
    '',
    '## 冗余操作',
    '第 5、7 条重复读了同一个文件。',
    '',
    '## 先读后改',
    '未观察到。',
  ].join('\n'));
  assert.deepEqual(parsed.missing, []);
  assert.deepEqual(parsed.dimensions.map((d) => d.label), ['绕路', '冗余操作', '先读后改']);
  assert.match(parsed.dimensions[0].body, /第 3 条/);
  assert.match(parsed.dimensions[1].body, /第 5、7 条/);
});

// 「缺维度」不能悄悄折成「没观察到」：那是把没做的判定说成做了的内容。
test('缺一节时点名缺哪个维度', () => {
  const parsed = parseJudgement('## 绕路\n没有绕路。\n\n## 先读后改\n每个任务都先读了。');
  assert.deepEqual(parsed.missing, ['冗余操作']);
  assert.equal(parsed.dimensions.length, 2);
});

test('标题被改写（多空格、不同措辞）不算覆盖：约定是逐字', () => {
  const parsed = parseJudgement('##  绕路\nx\n## 冗余\nx\n## 先读后改\nx');
  assert.deepEqual(parsed.missing, ['绕路', '冗余操作']);
});

test('某节有标题没内容也算缺——空节不是结论', () => {
  const parsed = parseJudgement('## 绕路\n\n## 冗余操作\nx\n## 先读后改\nx');
  assert.deepEqual(parsed.missing, ['绕路']);
});

test('judgeTextOf 取 result 事件的结论文本', () => {
  const events = [
    { type: 'assistant', message: { content: [{ type: 'text', text: '草稿' }] } },
    { type: 'result', result: '## 绕路\nx' },
  ];
  assert.equal(judgeTextOf(events), '## 绕路\nx');
});

test('没有 result 时退回 assistant 文本块拼接', () => {
  const events = [
    { type: 'assistant', message: { content: [{ type: 'text', text: '第一段' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '第二段' }] } },
  ];
  assert.equal(judgeTextOf(events), '第一段\n第二段');
});

test('什么都没有时返回 null，让调用方判缺失', () => {
  assert.equal(judgeTextOf([{ type: 'assistant', message: { content: [] } }]), null);
});

// ─────────────────────────────────────────────────────────────────────────
// judgeRun 的失败折成 missing：它不参与判定，任何一步失败都只让报告少一段。
// 用注入的 runSessionFn 驱动，不烧 API。
// ─────────────────────────────────────────────────────────────────────────

function judgeFixture(t, { session = {}, transcript = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, 'judge.ndjson');
  if (transcript) fs.writeFileSync(transcriptPath, transcript);
  return {
    transcriptPath,
    agentsPath: path.join(import.meta.dirname, '..', 'agents.json'),
    runSessionFn: async () => ({ exitCode: 0, timedOut: false, stderr: '', ...session }),
  };
}

const FULL_TEXT = '## 绕路\nx\n## 冗余操作\ny\n## 先读后改\nz';

function resultLine(text) {
  return `${JSON.stringify({ type: 'result', result: text })}\n`;
}

test('判定 agent 正常作答时给出三个维度', async (t) => {
  const fixture = judgeFixture(t, { transcript: resultLine(FULL_TEXT) });
  const out = await judgeRun({ prompt: 'p', agentsPath: fixture.agentsPath, ...fixture, runSessionFn: fixture.runSessionFn });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.dimensions.map((d) => d.label), ['绕路', '冗余操作', '先读后改']);
});

test('判定 agent 没正常结束时折成 missing，并说清退出码', async (t) => {
  const fixture = judgeFixture(t, { session: { exitCode: 2 }, transcript: resultLine(FULL_TEXT) });
  const out = await judgeRun({ prompt: 'p', agentsPath: fixture.agentsPath, ...fixture, runSessionFn: fixture.runSessionFn });
  assert.equal(out.status, 'missing');
  assert.match(out.reason, /退出码 2/);
});

test('判定 agent 超时时 missing 里标出超时', async (t) => {
  const fixture = judgeFixture(t, { session: { exitCode: 1, timedOut: true } });
  const out = await judgeRun({ prompt: 'p', agentsPath: fixture.agentsPath, ...fixture, runSessionFn: fixture.runSessionFn });
  assert.equal(out.status, 'missing');
  assert.match(out.reason, /超时/);
});

test('判定 agent 起不来时折成 missing，不抛', async (t) => {
  const fixture = judgeFixture(t);
  const out = await judgeRun({
    prompt: 'p',
    agentsPath: fixture.agentsPath,
    transcriptPath: fixture.transcriptPath,
    runSessionFn: async () => { throw new Error('claude executable not found'); },
  });
  assert.equal(out.status, 'missing');
  assert.match(out.reason, /claude executable not found/);
});

test('判定 agent 输出缺维度时折成 missing，点名缺哪个', async (t) => {
  const fixture = judgeFixture(t, { transcript: resultLine('## 绕路\nx\n## 先读后改\nz') });
  const out = await judgeRun({ prompt: 'p', agentsPath: fixture.agentsPath, ...fixture, runSessionFn: fixture.runSessionFn });
  assert.equal(out.status, 'missing');
  assert.match(out.reason, /冗余操作/);
});

test('判定 agent 什么都没写时折成 missing', async (t) => {
  const fixture = judgeFixture(t, { transcript: `${JSON.stringify({ type: 'system' })}\n` });
  const out = await judgeRun({ prompt: 'p', agentsPath: fixture.agentsPath, ...fixture, runSessionFn: fixture.runSessionFn });
  assert.equal(out.status, 'missing');
  assert.match(out.reason, /没有给出结论文本/);
});

test('判定 agent 的轨迹不存在时折成 missing，不抛', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = await judgeRun({
    prompt: 'p',
    agentsPath: path.join(import.meta.dirname, '..', 'agents.json'),
    transcriptPath: path.join(dir, 'nope.ndjson'),
    runSessionFn: async () => ({ exitCode: 0, timedOut: false, stderr: '' }),
  });
  assert.equal(out.status, 'missing');
  assert.match(out.reason, /轨迹读不出来/);
});

// ─────────────────────────────────────────────────────────────────────────
// 人工复核表（#10 / #25）：条目在 scenario.json 里声明，报告里给出任务 id 与预期。
// ─────────────────────────────────────────────────────────────────────────

test('复核条目原样规整成 {title, id, expect}', () => {
  const entries = reviewEntriesOf([{ title: 'CHECKLIST 任务', expect: '标题、N 条检查事项、说明文本' }]);
  assert.deepEqual(entries, [{ title: 'CHECKLIST 任务', id: null, expect: '标题、N 条检查事项、说明文本' }]);
});

test('缺字段的条目点名缺哪个字段，报告照常渲染而不静默丢掉', () => {
  const onlyTitle = reviewEntriesOf([{ title: '只有标题' }]);
  assert.deepEqual(onlyTitle[0].missingFields, ['expect']);
  const onlyExpect = reviewEntriesOf([{ expect: '只有预期' }]);
  assert.deepEqual(onlyExpect[0].missingFields, ['title']);
  const neither = reviewEntriesOf([{}]);
  assert.deepEqual(neither[0].missingFields, ['title', 'expect']);
});

test('非数组时报空表，不抛', () => {
  assert.deepEqual(reviewEntriesOf(undefined), []);
  assert.deepEqual(reviewEntriesOf({ title: 'x', expect: 'y' }), []);
});

// 探针没有判定要评（ADR-0015）：判定 agent 只属于 scenario 的产物。
// 这条守的是「探针不为一个不存在的判定面多烧一次 API」。
test('探针不起判定 agent', () => {
  assert.equal(needsJudgement('probe'), false);
});

test('正式用例要起判定 agent', () => {
  assert.equal(needsJudgement('scenario'), true);
});

// 判定 agent 的 cwd 是系统临时目录，要读的 runs/<runId>/ 在它之外（#10）。
// dontAsk 下不显式授权就每次被拒——那种失败只会表现为「判定缺失」，看不出是权限问题。
test('judgeRun 把运行目录加进 --add-dir', async (t) => {
  const fixture = judgeFixture(t, { transcript: resultLine(FULL_TEXT) });
  let seen = null;
  const out = await judgeRun({
    prompt: 'p',
    agentsPath: fixture.agentsPath,
    transcriptPath: fixture.transcriptPath,
    runDir: 'C:\runs\r1',
    runSessionFn: async ({ argv }) => { seen = argv; return { exitCode: 0, timedOut: false, stderr: '' }; },
  });
  assert.equal(out.status, 'ok');
  const at = seen.indexOf('--add-dir');
  assert.ok(at > -1, '必须传 --add-dir');
  assert.equal(seen[at + 1], 'C:\runs\r1');
});

test('没有 runDir 时不传 --add-dir，不造一个空目录参数', async () => {
  let seen = null;
  await judgeRun({
    prompt: 'p',
    agentsPath: path.join(import.meta.dirname, '..', 'agents.json'),
    transcriptPath: path.join(os.tmpdir(), 'nope-judge.ndjson'),
    runSessionFn: async ({ argv }) => { seen = argv; return { exitCode: 1, timedOut: false, stderr: '' }; },
  });
  assert.equal(seen.includes('--add-dir'), false);
});

// AC：复核清单每条给出任务 id。条目可以只写标题，跑完对着账本解析。
test('复核条目的标题对得上账本时补出任务 id', () => {
  const review = reviewEntriesOf([{ title: '装修准备', expect: '5 条检查事项' }]);
  const resolved = resolveReview(review, [{ id: 'aaaa00000000000000000001', title: '装修准备' }]);
  assert.equal(resolved[0].id, 'aaaa00000000000000000001');
  assert.equal(resolved[0].unresolved, undefined);
});

test('对不上账本时标 unresolved，不编一个 id 出来', () => {
  const resolved = resolveReview(reviewEntriesOf([{ title: '不存在' }]), []);
  assert.equal(resolved[0].id, null);
  assert.equal(resolved[0].unresolved, true);
});

test('条目直接写 id 时原样保留，不再按标题找', () => {
  const review = reviewEntriesOf([{ id: 'bbbb00000000000000000002', title: '随便什么', expect: 'x' }]);
  const resolved = resolveReview(review, [{ id: 'aaaa00000000000000000001', title: '随便什么' }]);
  assert.equal(resolved[0].id, 'bbbb00000000000000000002');
});

test('只写 id 不写标题也算完整条目', () => {
  const [entry] = reviewEntriesOf([{ id: 'bbbb00000000000000000002', expect: 'x' }]);
  assert.deepEqual(entry.missingFields, undefined);
});
