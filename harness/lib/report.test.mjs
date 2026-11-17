import test from 'node:test';
import assert from 'node:assert/strict';

import { renderHeader, renderReport, renderSummary } from './report.mjs';

const MANIFEST = {
  run: '2026-11-07T09-00-00-000Z-ab12cd',
  scenario: 'example-scenario',
  sandbox: 'C:\\Users\\Charles\\AppData\\Local\\Temp\\run-2026-11-07T09-00-00-000Z-ab12cd',
  skill: {
    source: 'E:\\repo\\skills\\dida-cli',
    sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    files: 4,
    git: { rev: '497093f1234567890abcdef1234567890abcdef', dirty: false },
  },
  model: {
    requested_alias: 'sonnet',
    provider: 'http://127.0.0.1:15721',
    alias_mapping: {
      sonnet: { model: 'ccs-claude-p23e2e3--deepseek-v4.1-flash[1M]', name: 'deepseek-v4.1-flash' },
    },
  },
  session: { exitCode: 0, timedOut: false, turns: 14, costUsd: 0.29 },
  created: [
    { id: 'aaaa00000000000000000001', projectId: '69abc459ebbdbd00000009f0', title: '周末露营' },
  ],
  calls: { path: 'runs/x/calls.ndjson', total: 12 },
  cleanup: { deleted: ['aaaa00000000000000000001'], failed: [], remaining: [], mismatched: [] },
};

test('报告首行同时给出 skill 指纹、模型与沙箱绝对路径', () => {
  const report = renderReport(MANIFEST);
  const firstLine = report.split('\n')[0];
  assert.match(firstLine, /a1b2c3d4e5f6/);
  assert.match(firstLine, /sonnet/);
  assert.match(firstLine, /C:\\Users\\Charles\\AppData\\Local\\Temp\\run-/);
});

test('scenario 与 run 标识在首行之后的标题行，不与首行抢位置', () => {
  const report = renderReport(MANIFEST);
  const lines = report.split('\n');
  assert.match(lines[0], /sandbox C:\\/);
  assert.match(lines[1], new RegExp(MANIFEST.scenario));
});

test('报告列出本次会话在测试清单里创建的全部任务 id', () => {
  const report = renderReport(MANIFEST);
  assert.match(report, /aaaa00000000000000000001/);
  assert.match(report, /周末露营/);
});

test('首行只写 CLI 自报的模型，不替它挑一个「实际模型」', () => {
  const manifest = {
    ...MANIFEST,
    model: {
      requested_alias: 'ccs-claude-p23e2e3--deepseek-v4.1-flash[1m]',
      provider: 'http://127.0.0.1:15721',
      alias_mapping: {
        sonnet: { model: 'ccs-claude-p23e2e3--deepseek-v4.1-flash[1M]', name: 'deepseek-v4.1-flash' },
      },
    },
  };
  const header = renderHeader(manifest);
  assert.match(header, /ccs-claude-p23e2e3--deepseek-v4\.1-flash\[1m\]/);
  assert.doesNotMatch(header, /→/);
});

test('报告里不出现别人的任务——清场只管自己的账本', () => {
  const report = renderReport({
    ...MANIFEST,
    cleanup: { deleted: [], failed: [], remaining: [], mismatched: [] },
  });
  assert.doesNotMatch(report, /别人建的/);
  assert.doesNotMatch(report, /未记账/);
  assert.doesNotMatch(report, /清场已停止/);
});

test('账本与实况的清单不一致时，报告写清楚出入', () => {
  const report = renderReport({
    ...MANIFEST,
    cleanup: {
      deleted: ['aaaa00000000000000000001'],
      failed: [],
      remaining: [],
      mismatched: [{ id: 'aaaa00000000000000000001', recordedAt: 'p1', actual: 'p2' }],
    },
  });
  assert.match(report, /账本记在 p1/);
  assert.match(report, /实际在 p2/);
});

test('删完仍在清单里时，报告点名是哪些 id', () => {
  const report = renderReport({
    ...MANIFEST,
    cleanup: { deleted: [], failed: [], remaining: ['aaaa00000000000000000001'], mismatched: [] },
  });
  assert.match(report, /删除后仍在清单里/);
  assert.match(report, /aaaa00000000000000000001/);
});

test('git 处于 dirty 状态时报告里标出来', () => {
  const header = renderHeader({ ...MANIFEST, skill: { ...MANIFEST.skill, git: { rev: '497093f', dirty: true } } });
  assert.match(header, /dirty/);
});

test('清场读账本出错时，报告写明原因而不是显示成删除 0 条', () => {
  const report = renderReport({
    ...MANIFEST,
    cleanup: { deleted: [], failed: [], remaining: [], mismatched: [], error: '账本不是合法 JSON' },
  });
  assert.match(report, /账本不是合法 JSON/);
});

test('报告写出三层模型信息：CLI 自报、真实映射、代理地址', () => {
  const manifest = {
    ...MANIFEST,
    model: {
      requested_alias: 'ccs-claude-p23e2e3--deepseek-v4.1-flash[1m]',
      provider: 'http://127.0.0.1:15721',
      alias_mapping: {
        sonnet: { model: 'ccs-claude-p23e2e3--deepseek-v4.1-flash[1M]', name: 'deepseek-v4.1-flash' },
        opus: { model: 'ccs-claude-p23e2e3--deepseek-v4.1-flash[1M]', name: 'deepseek-v4.1-flash' },
      },
    },
  };
  const report = renderReport(manifest);
  assert.match(report, /http:\/\/127\.0\.0\.1:15721/);
  assert.match(report, /sonnet/);
  assert.match(report, /opus/);
});

test('报告写明沙箱是保留还是已删除', () => {
  assert.match(renderReport({ ...MANIFEST, sandboxRetained: true }), /保留/);
  assert.match(renderReport({ ...MANIFEST, sandboxRetained: false }), /已删除/);
});

test('报告写明调用日志与轨迹是否对得上，不一致时点名是哪次调用没对上', () => {
  const ok = renderReport({ ...MANIFEST, calls: { ...MANIFEST.calls, crossCheck: { status: 'consistent' } } });
  const bad = renderReport({
    ...MANIFEST,
    calls: { ...MANIFEST.calls, crossCheck: { status: 'inconsistent', detail: '1 次 dida 调用在日志里找不到对应：task create --title z' } },
  });
  assert.match(ok, /对得上/);
  assert.match(bad, /与轨迹对不上/);
  // 判据改的是「逐调用比对」（#18）：读者要能看出是哪一次，而不是自己对着两个数猜
  assert.match(bad, /task create --title z/);
  // 不把结果说成「已确认绕过」：判据只能指出这次调用没进日志
  assert.doesNotMatch(bad, /绕过了 shim/);
});

test('有写命令被拒时，报告与摘要按原因分开写', () => {
  const manifest = { ...MANIFEST, calls: { ...MANIFEST.calls, rejected: 3, outOfBounds: 2 } };
  const report = renderReport(manifest);
  assert.match(report, /被拒绝的写命令 3 次/);
  assert.match(report, /越界写入 2 次/);
  assert.match(report, /解析不出目标 1 次/);
  assert.match(renderSummary(manifest), /3 次写命令被当场拒绝/);
});

test('只有越界写入时不提解析不出目标', () => {
  const manifest = { ...MANIFEST, calls: { ...MANIFEST.calls, rejected: 2, outOfBounds: 2 } };
  assert.doesNotMatch(renderReport(manifest), /解析不出目标/);
});

test('没有写命令被拒时不写这一行', () => {
  assert.doesNotMatch(renderReport(MANIFEST), /被拒绝的写命令/);
});

test('摘要给人读：一段话说完这次测了什么、跑了多少、建了什么', () => {
  const summary = renderSummary(MANIFEST);
  assert.match(summary, /example-scenario/);
  assert.match(summary, /14/);
  assert.match(summary, /1 条/);
});

test('报告带判定小节，断言失败时报告里就能读到失败项', () => {
  const report = renderReport({
    ...MANIFEST,
    assertion: { status: 'failed', results: [{ ok: false, name: '父任务正文非空', expected: '非空', actual: '（空）' }] },
  });
  assert.match(report, /## 判定/);
  assert.match(report, /结局断言 未通过/);
  assert.match(report, /父任务正文非空/);
});

test('断言模块坏掉（broken）但会话跑过时，报告仍要写清场——残留任务就藏在这一段里', () => {
  const report = renderReport({
    ...MANIFEST,
    assertion: { status: 'broken', detail: '断言模块没能给出结果数组', results: [] },
    cleanup: { deleted: [], failed: [], remaining: ['aaaa00000000000000000009'], mismatched: [] },
  });
  assert.match(report, /## 判定/);
  assert.match(report, /## 清场/);
  assert.match(report, /aaaa00000000000000000009/, '删完仍在清单里的任务必须点名');
  assert.match(report, /周末露营/, '本次创建的任务表也要在');
});

test('没开会话的运行（缺断言）只写判定，不写清场与模型', () => {
  const report = renderReport({
    run: 'r1',
    scenario: 's1',
    assertion: { status: 'missing', results: [] },
    session: {},
  });
  assert.match(report, /缺断言/);
  assert.doesNotMatch(report, /## 清场/);
  assert.doesNotMatch(report, /## 模型/);
});

// 清场门控（ADR-0014）：只有 PASSED 才清场，失败一律保留现场。
// 失败运行的报告是本 run 唯一的对照物——任务表告诉人该去清单里看哪几条。
const RETENTION = /现场已保留，用 `--clean 2026-11-07T09-00-00-000Z-ab12cd` 收尾/;

function retainedReport(assertion, cleanup = { deferred: true }) {
  return renderReport({ ...MANIFEST, assertion, cleanup });
}

test('四种失败结论的报告都写「现场已保留，用 --clean <runId> 收尾」', () => {
  for (const assertion of [
    { status: 'incomplete', results: [] },
    { status: 'invalid', cause: 'cross-check', detail: 'x', results: [] },
    { status: 'failed', results: [{ ok: false, name: 'x', expected: 1, actual: 2 }] },
    { status: 'broken', detail: 'x', results: [] },
  ]) {
    const report = retainedReport(assertion);
    assert.match(report, RETENTION, `${assertion.status} 的报告要说清现场怎么收尾`);
    assert.doesNotMatch(report, /按账本删除/, `${assertion.status} 不该写成已清场`);
  }
});

test('保留现场的报告仍列本次创建的任务，失败时才有的对照物', () => {
  const report = retainedReport({ status: 'failed', results: [{ ok: false, name: 'x', expected: 1, actual: 2 }] });
  assert.match(report, /## 本次创建的任务/);
  assert.match(report, /aaaa00000000000000000001/);
});

test('通过的报告写实际删除条数，不写现场已保留', () => {
  const report = retainedReport({ status: 'passed', results: [] }, { deleted: ['aaaa00000000000000000001'], failed: [], remaining: [], mismatched: [] });
  assert.match(report, /按账本删除 1 条/);
  assert.doesNotMatch(report, /现场已保留/);
});

test('摘要跟着判定走：失败写保留现场，通过写删掉几条', () => {
  const failed = renderSummary({
    ...MANIFEST,
    assertion: { status: 'failed', results: [{ ok: false, name: 'x', expected: 1, actual: 2 }] },
    cleanup: { deferred: true },
  });
  assert.match(failed, /现场已保留/);
  const passed = renderSummary({ ...MANIFEST, assertion: { status: 'passed', results: [] } });
  assert.match(passed, /清场删掉 1 条/);
  assert.doesNotMatch(passed, /现场已保留/);
});

test('清场真出错时报告写原因，不被「保留现场」掩盖', () => {
  const report = renderReport({
    ...MANIFEST,
    assertion: { status: 'passed', results: [] },
    cleanup: { deleted: [], failed: [], remaining: [], mismatched: [], error: '账本不是合法 JSON' },
  });
  assert.match(report, /清场未执行/);
  assert.match(report, /账本不是合法 JSON/);
  assert.doesNotMatch(report, /现场已保留/);
});

// --hold 让通过的运行也保留现场。那种运行的报告里不能出现「判定未通过」——
// 同一份报告上半截写「结局断言 通过」、下半截写「没通过」，就是 ADR-0014 要消除的
// 多结论并存，而且这一次是直接说反了。
test('通过的运行被 --hold 留下时，报告说清是 --hold，不冒充「判定未通过」', () => {
  const report = retainedReport({ status: 'passed', results: [] });
  assert.match(report, /现场已保留/);
  assert.match(report, /--hold/);
  assert.doesNotMatch(report, /判定未通过/);
  assert.doesNotMatch(report, /未通过/);
});

test('旧 manifest 的 skipped（incomplete 的旧名）保留现场理由与 incomplete 一致', () => {
  const text = renderSummary({
    ...MANIFEST,
    assertion: { status: 'skipped', results: [] },
    cleanup: { deferred: true },
  });
  assert.match(text, /会话没正常结束/);
  assert.doesNotMatch(text, /没有自动清场/);
});

// 可信度判据点名了哪几次调用没对上，读者需要轨迹路径自己去核对（#18 移交的第 3 条）。
test('报告给出轨迹路径，可信度结论才有可核对的证据来源', () => {
  const text = renderReport({
    ...MANIFEST,
    transcript: { path: 'C:/runs/x/trace.ndjson', events: 12, toolCalls: 4 },
  });
  assert.match(text, /轨迹 C:\/runs\/x\/trace\.ndjson/);
});

// ─────────────────────────────────────────────────────────────────────────
// 探针的报告（ADR-0015）：标题是「## 取样」而不是「## 判定」，
// 因为探针不判断言——用「判定」会让人以为 skill 被评过。
// ─────────────────────────────────────────────────────────────────────────

function probeManifest(overrides = {}) {
  return {
    ...MANIFEST,
    kind: 'probe',
    assertion: { status: 'sampled', results: [] },
    cleanup: { deferred: true },
    calls: {
      path: 'runs/x/calls.ndjson',
      total: 12,
      crossCheck: { status: 'consistent', calls: 12, shapeCalls: 12 },
    },
    ...overrides,
  };
}

test('探针报告用「## 取样」作标题，不出现「## 判定」', () => {
  const report = renderReport(probeManifest());
  assert.match(report, /## 取样/);
  assert.doesNotMatch(report, /## 判定/);
});

test('探针报告写明结论是「已取样」，不冒充通过', () => {
  const report = renderReport(probeManifest());
  assert.match(report, /已取样/);
  assert.doesNotMatch(report, /结局断言 通过/, '「通过」是 judgement 的词，探针没有判定');
  assert.doesNotMatch(report, /未通过/);
});

// 判据在 #18 从「比条数」改成逐调用比对之后，报告不再有两个条数可写。
// 写断言的人仍要能自查样本可靠性：那改由可信度结论本身承担。
test('探针报告写明可信度结论——写断言的人靠它自查样本可靠性', () => {
  const report = renderReport(probeManifest());
  assert.match(report, /与轨迹对得上/);
});

test('探针报告写「未清场」并说明是探针保留现场', () => {
  const report = renderReport(probeManifest());
  assert.match(report, /未清场/);
  assert.match(report, /探针/);
  assert.match(report, /写断言/);
});

test('探针的空样本明说「本次没有创建任何任务」', () => {
  const report = renderReport(probeManifest({ created: [] }));
  assert.match(report, /没有创建任何任务/);
});

test('探针的 incomplete 沿用同一个词，不写成「跳过」', () => {
  const report = renderReport(probeManifest({
    assertion: { status: 'incomplete', results: [] },
  }));
  assert.match(report, /会话没正常结束/);
  assert.doesNotMatch(report, /跳过/);
});

test('探针的 invalid 带 cause 时用 scenario 同款的标题', () => {
  const report = renderReport(probeManifest({
    assertion: {
      status: 'invalid',
      cause: 'cross-check',
      detail: '调用日志与轨迹对不上：3 条 dida 调用 / 4 次 PowerShell',
      results: [{ ok: false, name: '可信度检查', expected: 'x', actual: '3 条 dida 调用 / 4 次 PowerShell' }],
    },
  }));
  assert.match(report, /## 取样/);
  assert.match(report, /结果不可信/);
  assert.match(report, /3 条 dida 调用/);
});

test('scenario 的报告仍是「## 判定」，探针分支不串到它', () => {
  const report = renderReport({ ...MANIFEST, assertion: { status: 'passed', results: [] } });
  assert.match(report, /## 判定/);
  assert.doesNotMatch(report, /## 取样/);
});

test('探针的摘要说「探针 … 跑了一次真实会话」，不冒充 scenario', () => {
  const text = renderSummary(probeManifest());
  assert.match(text, /^探针 example-scenario/);
  assert.doesNotMatch(text, /^scenario/);
});

test('探针摘要说保留现场供人写断言，不按判定结论编理由', () => {
  const text = renderSummary(probeManifest());
  assert.match(text, /保留现场供人查看与写断言/);
  assert.doesNotMatch(text, /断言未通过/);
});

// AC：探针里放了 assert.mjs 时，控制台与报告各留一行提示（ADR-0015）。
test('探针报告提示 assert.mjs 未被使用', () => {
  const report = renderReport(probeManifest({ unusedAssert: true }));
  assert.match(report, /未被使用/);
  assert.match(report, /assert\.mjs/);
  assert.match(report, /scenarios/);
});

test('没放 assert.mjs 的探针报告不出现这条提示', () => {
  const report = renderReport(probeManifest({ unusedAssert: false }));
  assert.doesNotMatch(report, /未被使用/);
});

// 报告必须能一眼看出这是探针还是正式用例（问题 1）：
// 两者的标题与首行原本完全同构，不看 manifest 根本分不出。
// 只查标题行——正文里本来就散落着「探针」「scenario」字样，查全文等于没查。
function titleLineOf(manifest) {
  return renderReport(manifest).split('\n').find((line) => line.startsWith('# '));
}

test('正式用例的标题行标出「scenario」，且不写「探针」', () => {
  const title = titleLineOf({ ...MANIFEST, kind: 'scenario', assertion: { status: 'passed', results: [] } });
  assert.match(title, /scenario/);
  assert.doesNotMatch(title, /探针/);
});

test('探针的标题行标出「探针」', () => {
  assert.match(titleLineOf(probeManifest()), /探针/);
});

test('探针标识出现在标题行，不用翻到摘要才看得到', () => {
  const report = renderReport(probeManifest());
  const titleLine = report.split('\n').find((line) => line.startsWith('# '));
  assert.match(titleLine, /探针/);
});

test('正式用例标识同样出现在标题行', () => {
  const report = renderReport({ ...MANIFEST, kind: 'scenario', assertion: { status: 'passed', results: [] } });
  const titleLine = report.split('\n').find((line) => line.startsWith('# '));
  assert.match(titleLine, /scenario/);
});
