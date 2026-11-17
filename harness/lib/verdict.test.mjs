import test from 'node:test';
import assert from 'node:assert/strict';

import { INCOMPLETE_FACT, invalidLabel, invalidTitle, renderAssertions, renderVerdict } from './report.mjs';

test('断言全过时报告写「通过」，不点名任何断言', () => {
  const text = renderVerdict({
    assertion: { status: 'passed', results: [{ ok: true, name: '父任务正文非空', expected: '非空', actual: '非空' }] },
  });
  assert.match(text, /结局断言 通过/);
  assert.doesNotMatch(text, /父任务正文非空/);
});

test('快照取不到（invalid, cause=state）写成「结果不可用」，不写成用例配置错误', () => {
  const text = renderVerdict({
    assertion: {
      status: 'invalid',
      cause: 'state',
      detail: '取终态快照失败：列清单 p 的任务失败：网络抖动。这是基础设施故障，重跑一次。',
      results: [{ ok: false, name: '终态快照不可用', expected: '能列出测试清单', actual: '网络抖动' }],
    },
  });
  assert.match(text, /不可用/);
  assert.match(text, /网络抖动/);
  assert.match(text, /重跑一次/);
  assert.doesNotMatch(text, /用例配置错误/);
});

// 验收标准：两种失败措辞与指引互不混淆——一个让人重跑，一个让人改 skill。
// 只查各自的词不够：要查「另一个的指引没有串过来」。
test('快照取不到与断言不通过：措辞、指引、标题三者互不串台', () => {
  const stateFail = renderVerdict({
    assertion: {
      status: 'invalid',
      cause: 'state',
      detail: '取终态快照失败：网络抖动。这是基础设施故障，重跑一次。',
      results: [{ ok: false, name: '终态快照不可用', expected: '能列出测试清单', actual: '网络抖动' }],
    },
  });
  const assertFail = renderVerdict({
    assertion: {
      status: 'failed',
      results: [{ ok: false, name: '父任务应为 TEXT', expected: 'TEXT', actual: 'CHECKLIST' }],
    },
  });

  assert.doesNotMatch(stateFail, /结局断言 未通过/, '快照取不到时断言没跑过');
  assert.doesNotMatch(stateFail, /父任务应为 TEXT/);
  assert.doesNotMatch(assertFail, /终态快照/);
  assert.doesNotMatch(assertFail, /基础设施故障/);
  assert.doesNotMatch(assertFail, /结果不可用/);
  // 两边的指引各说各的：快照指向重跑，断言指向改 skill。
  assert.match(stateFail, /重跑一次/);
  assert.match(assertFail, /改 skill/);
});

test('旧 manifest 的 invalid 没有 cause 时用通用标题，不崩', () => {
  const text = renderVerdict({
    assertion: { status: 'invalid', detail: '取终态快照失败：x', results: [] },
  });
  assert.match(text, /本次结果不可用/);
});

test('断言模块坏（broken）写成用例配置错误，与 invalid 分开', () => {
  const broken = renderVerdict({
    assertion: { status: 'broken', detail: '断言模块没能给出结果数组', results: [] },
  });
  const invalid = renderVerdict({
    assertion: { status: 'invalid', detail: '取终态快照失败：网络抖动', results: [] },
  });
  assert.match(broken, /用例配置错误/);
  assert.doesNotMatch(broken, /不可用/);
  assert.match(invalid, /不可用/);
  assert.doesNotMatch(invalid, /用例配置错误/);
});

test('旧 manifest（没有 assertion 字段）不写「通过」——它根本没评过', () => {
  const text = renderVerdict({ assertion: undefined });
  assert.doesNotMatch(text, /结局断言 通过/);
  assert.match(text, /未评断言/);
});

test('status 是 incomplete 时也不写「通过」', () => {
  const text = renderVerdict({ assertion: { status: 'incomplete', results: [] } });
  assert.doesNotMatch(text, /结局断言 通过/);
  assert.match(text, /判定链未开始/);
});

test('断言未通过时报告点名失败的那条，并同时写出期望值与实际值', () => {
  const text = renderVerdict({
    assertion: {
      status: 'failed',
      results: [
        { ok: true, name: '父任务正文非空', expected: '非空', actual: '非空' },
        { ok: false, name: '恰好一个父任务带 5 条子任务', expected: 1, actual: 4 },
      ],
    },
  });
  assert.match(text, /结局断言 未通过/);
  assert.match(text, /恰好一个父任务带 5 条子任务/);
  assert.match(text, /期望 1/);
  assert.match(text, /实际 4/);
  // 通过的那条不刷屏
  assert.doesNotMatch(text, /父任务正文非空/);
});

test('缺断言写成「用例配置错误」，与「结局断言 未通过」分开', () => {
  const missing = renderVerdict({ assertion: { status: 'missing', results: [] } });
  const failed = renderVerdict({
    assertion: { status: 'failed', results: [{ ok: false, name: 'x', expected: 1, actual: 2 }] },
  });
  assert.match(missing, /缺断言/);
  assert.match(missing, /用例配置错误/);
  assert.doesNotMatch(missing, /结局断言 未通过/);
  assert.doesNotMatch(failed, /缺断言/);
});

test('会话没正常结束 → 报告写「判定链未开始」，不写「不据此判定成败」', () => {
  const text = renderVerdict({
    assertion: { status: 'incomplete', results: [] },
  });
  assert.match(text, /会话没正常结束/);
  assert.match(text, /判定链未开始/);
  assert.match(text, new RegExp(INCOMPLETE_FACT), '报告与控制台共用同一句，别各写一份');
  assert.doesNotMatch(text, /不据此判定成败/);
  assert.doesNotMatch(text, /跳过/);
});

// 任务表与判定链正交（ADR-0014）：会话没正常结束时也要能看到本次建了什么，
// 否则「现场已保留」这句没有下手的地方。
test('会话没正常结束时，整份报告里仍有本次创建的任务表', async () => {
  const { renderReport } = await import('./report.mjs');
  const report = renderReport({
    scenario: 's', run: 'r', sandbox: '/tmp/x', skill: { sha256: 'a', files: 1, git: {} },
    model: { requested_alias: 'x', alias_mapping: {} },
    session: { exitCode: 1, timedOut: false, turns: 3, costUsd: 0 },
    created: [{ id: 'aaaa00000000000000000001', projectId: 'p1', title: '半路建的任务' }],
    cleanup: { deferred: true },
    assertion: { status: 'incomplete', results: [] },
  });
  assert.match(report, /## 本次创建的任务/);
  assert.match(report, /aaaa00000000000000000001/);
  assert.match(report, /半路建的任务/);
  assert.match(report, /判定链未开始/);
});

// 前置门没过时可信度检查根本没跑过（ADR-0014）。manifest 里的 crossCheck 是
// credibilityOf 无条件算出来的，报告照搬它就会在「判定链未开始」旁边再摆一组
// 「与轨迹对不上」——正是 ADR-0014 要消除的形状。
// 正反两条一起测：只测「不在」的话，把守卫改成恒 false 也照样绿。
const CROSS_MANIFEST = {
  scenario: 's', run: 'r', sandbox: '/tmp/x', skill: { sha256: 'a', files: 1, git: {} },
  model: { requested_alias: 'x', alias_mapping: {} },
  session: { exitCode: 0, timedOut: false, turns: 3, costUsd: 0 },
  created: [],
  cleanup: { deleted: [] },
  calls: { path: 'c', total: 1, rejected: 0, outOfBounds: 0, crossCheck: { status: 'inconsistent', detail: '1 次 dida 调用在日志里找不到对应：task get' } },
};

test('会话没正常结束时，报告不渲染可信度结论——判定链没开始，没有这组结论', async () => {
  const { renderReport } = await import('./report.mjs');
  const report = renderReport({ ...CROSS_MANIFEST, assertion: { status: 'incomplete', results: [] } });
  assert.doesNotMatch(report, /与轨迹对不上/);
  assert.doesNotMatch(report, /与轨迹对得上/);
});

test('会话正常结束时，同样的 crossCheck 要渲染出来——守卫不能把这一面整个关掉', async () => {
  const { renderReport } = await import('./report.mjs');
  const report = renderReport({ ...CROSS_MANIFEST, assertion: { status: 'invalid', cause: 'cross-check', detail: 'x', results: [] } });
  assert.match(report, /与轨迹对不上/);
});

test('期望值与实际值是对象时按 JSON 写，不写成 [object Object]', () => {
  const text = renderAssertions([
    { ok: false, name: '父任务', expected: { kind: 'TEXT' }, actual: { kind: 'CHECKLIST' } },
  ]);
  assert.match(text, /"kind":"TEXT"/);
  assert.match(text, /"kind":"CHECKLIST"/);
  assert.doesNotMatch(text, /\[object Object\]/);
});

test('序列化不了的值（循环引用 / BigInt）折成一句人话，不让报告崩掉', () => {
  const circular = {};
  circular.self = circular;
  const text = renderAssertions([
    { ok: false, name: '循环', expected: circular, actual: 'y' },
    { ok: false, name: '大数', expected: 1n, actual: 'y' },
  ]);
  assert.match(text, /无法序列化/);
  assert.doesNotMatch(text, /object Object/);
});

// 「## 会话」小节的三态：判不出结论时不能写「对得上」。
test('crossCheck 三态：consistent / inconsistent / indeterminate 各写各的，互不冒充', async () => {
  const { renderReport } = await import('./report.mjs');
  const base = {
    scenario: 's', run: 'r', sandbox: '/tmp/x', skill: { sha256: 'a', files: 1, git: {} },
    model: { requested_alias: 'x', alias_mapping: {} },
    session: { exitCode: 0, turns: 1, costUsd: 0 }, created: [], cleanup: { deleted: [] },
    assertion: { status: 'passed', results: [] },
  };
  const at = (status) => renderReport({
    ...base,
    calls: {
      path: 'c',
      total: 1,
      rejected: 0,
      outOfBounds: 0,
      crossCheck: {
        status,
        detail: status === 'consistent' ? '轨迹里的 dida 调用在日志里都有对应' : '轨迹里有命令解析不出是不是 dida 调用',
      },
    },
  });

  assert.match(at('consistent'), /与轨迹对得上/);
  assert.match(at('inconsistent'), /与轨迹对不上/);
  const unknown = at('indeterminate');
  assert.match(unknown, /无法比对/);
  assert.doesNotMatch(unknown, /与轨迹对得上/, '不知道有没有问题，不能说没问题');
});

// 这三个用例钉的是**标题本身**，不是 detail。之前只断 detail 里的词，
// 把 INVALID_CAUSES 里的标题改错测试仍全绿（变异验证过）。
test('三种 cause 的标题各自不同', () => {
  assert.match(invalidTitle('cross-check'), /调用日志与轨迹对不上/);
  assert.match(invalidTitle('indeterminate'), /轨迹读不出/);
  assert.match(invalidTitle('state'), /终态快照取不到/);
  // 三种标题两两不同
  const titles = ['cross-check', 'indeterminate', 'state'].map(invalidTitle);
  assert.equal(new Set(titles).size, 3);
});

test('判不出结论时标题不能说「可能绕过了」——那是在断言没观测到的事实', () => {
  assert.doesNotMatch(invalidTitle('indeterminate'), /绕过/);
  assert.doesNotMatch(invalidTitle('state'), /绕过/);
});

test('未知 cause 退回通用标题，不崩', () => {
  assert.equal(invalidTitle(undefined), '本次结果不可用');
  assert.equal(invalidTitle('nonsense'), '本次结果不可用');
});

test('invalidLabel 三种 cause 各自不同，未知退回通用', () => {
  assert.equal(invalidLabel('cross-check'), '结果不可信');
  assert.equal(invalidLabel('indeterminate'), '无从判定');
  assert.equal(invalidLabel('state'), '结果不可用');
  assert.equal(invalidLabel(undefined), '结果不可用');
  assert.equal(invalidLabel('nonsense'), '结果不可用');
});

// 可信度失败即终止判定链（ADR-0014）：报告里只有第一面这一节结论。
// 一次运行只给一个结论——读者无从判断「结果不可信」旁边那组断言该不该信。
// 旧 manifest 里残留的 evaluated 字段一并忽略：--clean 会用当前代码重渲染旧报告。
test('可信度失败时报告只有一面结论，旧 manifest 残留的 evaluated 也不渲染', () => {
  const text = renderVerdict({
    assertion: {
      status: 'invalid',
      cause: 'cross-check',
      detail: '调用日志与轨迹对不上：3 条 dida 调用 / 4 次 PowerShell',
      results: [{ ok: false, name: '可信度检查', expected: 'x', actual: 'y' }],
      evaluated: {
        status: 'failed',
        results: [{ ok: false, name: '父任务应为 TEXT', expected: 'TEXT', actual: 'CHECKLIST' }],
      },
    },
  });
  assert.match(text, /调用日志与轨迹对不上/);
  assert.match(text, /可信度检查/);
  assert.doesNotMatch(text, /同一份终态/, 'evaluated 整节已删除');
  assert.doesNotMatch(text, /父任务应为 TEXT/, '后面各面的结论不该再出现');
  assert.doesNotMatch(text, /结局断言/, '可信度失败时没有结局断言这一面');
});

// 会话没正常结束时，报告里不该出现任何断言结论——判定链没开始，也没有结论可带。
// 旧 manifest 里残留的 evaluated 字段（旧版本落下的）一并忽略，否则读者会看到
// 一份「判定链未开始」下面紧跟一组「断言未通过」，又回到 ADR-0014 要消除的形状。
test('会话没正常结束时，manifest 里残留的 evaluated 不渲染', () => {
  const text = renderVerdict({
    assertion: {
      status: 'incomplete',
      results: [],
      evaluated: { status: 'failed', results: [{ ok: false, name: 'x', expected: 1, actual: 2 }] },
    },
  });
  assert.match(text, /判定链未开始/);
  assert.doesNotMatch(text, /同一份终态的结局断言/);
  assert.doesNotMatch(text, /期望 1/);
});

test('旧 manifest 里 status=skipped 也按「判定链未开始」渲染', () => {
  const text = renderVerdict({ assertion: { status: 'skipped', results: [] } });
  assert.match(text, /判定链未开始/);
});

// 旧 manifest 里可信度失败落的是 invalid，而那次会话的退出码同样非零。那次快照取了、
// 断言也跑了，按前置门写「没有取终态快照，也没有跑任何断言」等于说一件没发生过的事。
// 渲染只看 status，不看退出码——这条钉的就是这一点。
test('status=invalid 一律按结果不可用渲染，不冒充前置门', () => {
  const text = renderVerdict({
    assertion: { status: 'invalid', cause: 'cross-check', detail: '调用日志与轨迹对不上：3 / 4', results: [] },
  });
  assert.match(text, /调用日志与轨迹对不上/);
  assert.doesNotMatch(text, /判定链未开始/);
  assert.doesNotMatch(text, /没有取终态快照/);
});

test('可信度失败（会话正常结束）时也不出现会话中断的措辞', () => {
  const text = renderVerdict({
    assertion: {
      status: 'invalid',
      cause: 'cross-check',
      detail: 'x',
      results: [],
      evaluated: { status: 'failed', results: [{ ok: false, name: 'y', expected: 1, actual: 0 }] },
    },
  });
  assert.doesNotMatch(text, /会话在此终止/);
});

// 预设失败（#19）：这次 run 在建运行目录之前就停了，判定链无从开始。
// 措辞要指向 preset.mjs，并点名账本还在、--clean 收得到。
test('预设失败时报告说明没进入会话，并指向 preset.mjs', () => {
  const text = renderVerdict({
    assertion: { status: 'preset-failed', detail: '预设被拒绝（out-of-bounds）：目标不在本次清单集合内', results: [] },
    run: 'r-1',
  });
  assert.match(text, /预设失败/);
  assert.match(text, /没有进入会话/);
  assert.match(text, /out-of-bounds/);
  assert.match(text, /preset\.mjs/);
  assert.match(text, /--clean/);
  assert.doesNotMatch(text, /断言未通过/, '这不是断言这一面的事');
  assert.doesNotMatch(text, /重跑一次/, '预设写错了，重跑不会好');
});
