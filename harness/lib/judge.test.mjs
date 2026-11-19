import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildDigest,
  buildJudgePrompt,
  createJudgeSandbox,
  DIMENSIONS,
  judgeRun,
  judgeTextOf,
  parseJudgement,
  resolveReview,
  reviewEntriesOf,
} from './judge.mjs';
import { needsJudgement } from '../run.mjs';
import { sandboxRootOf } from './sandbox.mjs';

// ─────────────────────────────────────────────────────────────────────────
// 判定 agent 不参与判定（#10）：它的输出只写到报告里，退出码与 status 都不看它。
// 所以这一层的每一个失败都要折成「判定缺失」，绝不抛——抛了会让一次已经跑完的
// 会话连判定结论都落不下。
// ─────────────────────────────────────────────────────────────────────────

const DIGEST = 'C:\\runs\\x\\judge\\work\\digest.md';

test('prompt 只指向摘要文件，判定 agent 才读得到依据', () => {
  const prompt = buildJudgePrompt({
    scenario: 's1',
    prompt: '把 materials/plan.md 建成检查清单',
    digestPath: DIGEST,
    created: [{ id: 'aaaa00000000000000000001', title: '装修准备' }],
  });
  assert.match(prompt, /digest\.md/);
  assert.match(prompt, /把 materials\/plan\.md 建成检查清单/);
  assert.match(prompt, /aaaa00000000000000000001/);
});

// 原始轨迹是噪音：1994 条事件、507KB，judge 会花 30 次调用在里面翻。
// prompt 里不能再出现它的路径，否则等于请它去读。
test('prompt 不指向原始轨迹或调用日志', () => {
  const prompt = buildJudgePrompt({ scenario: 's1', prompt: 'x', digestPath: DIGEST });
  assert.doesNotMatch(prompt, /trace\.ndjson/);
  assert.doesNotMatch(prompt, /calls\.ndjson/);
});

// 三个维度是 AC 的点名项。dimensions 少一个，报告那段就不算「覆盖三面」。
test('prompt 点名三个维度，且与 DIMENSIONS 同源', () => {
  const prompt = buildJudgePrompt({ scenario: 's1', prompt: 'x', digestPath: DIGEST });
  assert.equal(DIMENSIONS.length, 3);
  for (const dimension of DIMENSIONS) assert.match(prompt, new RegExp(dimension.label));
  assert.match(prompt, /绕路/);
  assert.match(prompt, /冗余操作/);
  assert.match(prompt, /先读后改/);
});

test('没建出任务时 prompt 说清楚，不留一张空表', () => {
  const prompt = buildJudgePrompt({ scenario: 's1', prompt: 'x', digestPath: DIGEST, created: [] });
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

// 判定 agent 有自己的沙箱（#10）：cwd 是 run-<runId>/judge/work/，里面只有摘要。
// 它读不到被测 agent 的 skill 副本、materials 与原始轨迹——那些是噪音，
// 让评价被 skill 自己的措辞带偏。也不该需要 --add-dir：要读的都在 cwd 里。
test('judgeRun 以 judge/work 为 cwd，不传 --add-dir', async (t) => {
  const fixture = judgeFixture(t, { transcript: resultLine(FULL_TEXT) });
  let seen = null;
  const out = await judgeRun({
    prompt: 'p',
    agentsPath: fixture.agentsPath,
    transcriptPath: fixture.transcriptPath,
    workDir: 'C:\\Temp\\run-x\\judge\\work',
    runSessionFn: async (input) => { seen = input; return { exitCode: 0, timedOut: false, stderr: '' }; },
  });
  assert.equal(out.status, 'ok');
  assert.equal(seen.cwd, 'C:\\Temp\\run-x\\judge\\work');
  assert.equal(seen.argv.includes('--add-dir'), false, '要读的都在 cwd 里，不必再授权外部目录');
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

// ─────────────────────────────────────────────────────────────────────────
// 摘要（#10 的修正）：判定 agent 读的不是原始轨迹，是 harness 抽好的一份摘要。
// 原始轨迹里 1994 条事件全部塞进去，等于把找线索的活推给它——实测 40 轮、$0.32，
// 是被测会话的 2.5 倍。摘要只留判断三个维度需要的：每次工具调用的动作与结果片段。
// ─────────────────────────────────────────────────────────────────────────

const ASSISTANT = (blocks) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } });
const RESULT = (id, content) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
});

test('摘要按顺序列出每次工具调用与它的结果', () => {
  const digest = buildDigest({
    events: [
      ASSISTANT([{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'materials/plan.md' } }]),
      RESULT('a', '# 周末露营准备\n出发前过一遍'),
      ASSISTANT([{ type: 'tool_use', id: 'b', name: 'PowerShell', input: { command: 'dida task create --title x' } }]),
      RESULT('b', 'ID: 6afdab19e4b0d2656c162052'),
    ],
  });
  assert.match(digest, /Read/);
  assert.match(digest, /materials\/plan\.md/);
  assert.match(digest, /PowerShell/);
  assert.match(digest, /task create/);
  assert.match(digest, /6afdab19e4b0d2656c162052/);
  assert.ok(digest.indexOf('materials/plan.md') < digest.indexOf('task create'), '按发生顺序');
});

// 结果可能是长文件、长 JSON：截断，否则摘要就成了另一份原始轨迹。
test('单个结果截断，不让一份长输出吃掉整份摘要', () => {
  const long = 'x'.repeat(3000);
  const digest = buildDigest({
    events: [
      ASSISTANT([{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'big.md' } }]),
      RESULT('a', long),
    ],
  });
  assert.ok(digest.length < 1500, `摘要不该被一份长输出撑大：${digest.length}`);
});

test('工具结果里没有对应调用的，不凭空造一条', () => {
  const digest = buildDigest({ events: [RESULT('orphan', '孤立的输出')] });
  assert.doesNotMatch(digest, /孤立的输出/);
});

test('摘要不含 assistant 的思考与正文——判断依据是动作，不是它怎么想', () => {
  const digest = buildDigest({
    events: [
      ASSISTANT([
        { type: 'text', text: '我先看一下这个文件' },
        { type: 'thinking', thinking: '内部推理' },
        { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'x.md' } },
      ]),
      RESULT('a', '内容'),
    ],
  });
  assert.doesNotMatch(digest, /我先看一下这个文件/);
  assert.doesNotMatch(digest, /内部推理/);
});

// 偏离调用日志（shim 记的真 argv）是判断「走了哪些 dida 命令」的权威来源，
// 轨迹里的命令字符串可能被 shell 包装或改写。摘要把两者放在一起。
test('摘要带 dida 调用的 argv，不只是轨迹里的命令字符串', () => {
  const digest = buildDigest({
    events: [
      ASSISTANT([{ type: 'tool_use', id: 'a', name: 'PowerShell', input: { command: 'dida task create --title x' } }]),
      RESULT('a', 'ID: 6afdab19e4b0d2656c162052'),
    ],
    calls: [{ argv: ['task', 'create', '--title', 'x'], decision: 'allowed' }],
  });
  assert.match(digest, /task create --title x/);
});

// 判定 agent 的沙箱（#10）放在 run-<runId>/judge/：cwd 里只有一份摘要，
// config 里只有 ANTHROPIC_* 键。skill 副本、materials、shim 都不在这里。
test('判定沙箱只给摘要与凭据，不给被测 skill 与 materials', (t) => {
  const runId = `judge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  t.after(() => fs.rmSync(sandboxRootOf(runId), { recursive: true, force: true }));

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-rundir-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));

  const sb = createJudgeSandbox({ runId, runDir, anthropicEnv: { ANTHROPIC_MODEL: 'x' }, digest: '# 会话摘要' });

  assert.equal(path.dirname(sb.workDir), sb.root, 'work/ 在 judge/ 下');
  assert.equal(path.dirname(sb.root), sandboxRootOf(runId), 'judge/ 直接在运行目录下');
  assert.equal(path.basename(sb.root), 'judge');
  assert.equal(fs.readFileSync(sb.digestPath, 'utf8').trim(), '# 会话摘要');
  assert.deepEqual(fs.readdirSync(sb.workDir), ['digest.md'], 'cwd 里只有摘要');
  const settings = JSON.parse(fs.readFileSync(path.join(sb.configDir, 'settings.json'), 'utf8'));
  assert.deepEqual(settings.env, { ANTHROPIC_MODEL: 'x' });
  assert.deepEqual(fs.readdirSync(sb.configDir), ['settings.json'], '不给 skill 副本');
  assert.equal(fs.readFileSync(sb.keptDigestPath, 'utf8').trim(), '# 会话摘要', 'run 目录里也要留一份，沙箱删了还查得到');
  assert.equal(path.dirname(sb.keptDigestPath), runDir);
});

// 摘要会进另一个模型的会话。`dida auth status` 的输出里带 token，
// 原样贴过去等于把凭据交给判定 agent，也留在了 digest.md 里。
test('摘要里的 token 被脱敏', () => {
  const digest = buildDigest({
    events: [
      ASSISTANT([{ type: 'tool_use', id: 'a', name: 'PowerShell', input: { command: 'dida auth status' } }]),
      RESULT('a', '✓ 已登录\n  Token: dp_48d71abc7930\n'),
    ],
  });
  assert.doesNotMatch(digest, /dp_48d71abc7930/);
  assert.match(digest, /已登录/);
  assert.match(digest, /已脱敏/);
});
