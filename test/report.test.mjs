import test from 'node:test';
import assert from 'node:assert/strict';

import { renderHeader, renderReport, renderSummary } from '../harness/lib/report.mjs';

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
  cleanup: { deleted: ['aaaa00000000000000000001'], failed: [], foreign: [] },
};

test('报告首行同时给出 skill 指纹、模型与沙箱绝对路径', () => {
  const header = renderHeader(MANIFEST);
  assert.equal(header.split('\n').length, 1);
  assert.match(header, /a1b2c3d4e5f6/);
  assert.match(header, /deepseek-v4\.1-flash/);
  assert.match(header, /C:\\Users\\Charles\\AppData\\Local\\Temp\\run-/);
});

test('报告首行不出现在文件的第二行之后——它是第一行', () => {
  const report = renderReport(MANIFEST);
  assert.equal(report.split('\n')[0], `# ${MANIFEST.scenario}  ${MANIFEST.run}`);
  assert.equal(report.split('\n')[2], renderHeader(MANIFEST));
});

test('报告列出本次会话在测试清单里创建的全部任务 id', () => {
  const report = renderReport(MANIFEST);
  assert.match(report, /aaaa00000000000000000001/);
  assert.match(report, /周末露营/);
});

test('CLI 自报的是完整模型名时，反查出别名映射里的真实模型', () => {
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
  assert.match(header, /deepseek-v4\.1-flash/);
  assert.doesNotMatch(header, /unknown/);
});

test('报告区分清场删掉的任务与清单里未记账的任务', () => {
  const report = renderReport({
    ...MANIFEST,
    cleanup: {
      deleted: [],
      failed: [],
      foreign: [{ projectId: '69abc459ebbdbd00000009f0', id: 'bbbb00000000000000000002', title: '别人建的' }],
    },
  });
  assert.match(report, /bbbb00000000000000000002/);
  assert.match(report, /未记账/);
});

test('git 处于 dirty 状态时报告里标出来', () => {
  const header = renderHeader({ ...MANIFEST, skill: { ...MANIFEST.skill, git: { rev: '497093f', dirty: true } } });
  assert.match(header, /dirty/);
});

test('摘要给人读：一段话说完这次测了什么、跑了多少、建了什么', () => {
  const summary = renderSummary(MANIFEST);
  assert.match(summary, /s1-plan-to-task/);
  assert.match(summary, /14/);
  assert.match(summary, /1 条/);
});
