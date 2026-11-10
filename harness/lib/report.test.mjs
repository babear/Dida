import test from 'node:test';
import assert from 'node:assert/strict';

import { renderHeader, renderReport, renderSummary } from './report.mjs';

const MANIFEST = {
  run: '2026-11-07T09-00-00-000Z-ab12cd',
  scenario: 's1-plan-to-task',
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

test('报告写明调用日志与轨迹是否对得上', () => {
  const ok = renderReport({ ...MANIFEST, calls: { ...MANIFEST.calls, crossCheck: { calls: 12, shapeCalls: 10, consistent: true } } });
  const bad = renderReport({ ...MANIFEST, calls: { ...MANIFEST.calls, crossCheck: { calls: 3, shapeCalls: 10, consistent: false } } });
  assert.match(ok, /对得上/);
  assert.match(bad, /绕过/);
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
  assert.match(summary, /s1-plan-to-task/);
  assert.match(summary, /14/);
  assert.match(summary, /1 条/);
});
