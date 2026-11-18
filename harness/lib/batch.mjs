// 批跑汇总（#9）：跑完一批之后要能一眼回答「几条过、几条没过、分别是什么性质」。
// 关键是不能把 invalid 与 failed 折叠成同一个「失败」——退出码都非零，
// 但一个去改 skill，一个去查 harness 或重跑（ADR-0012）。所以按结论分别计数。
//
// 每条 run 的形状：`{ scenario, status, ok, attempts }`。
//   status  判定结论（scenario：passed / failed / invalid / incomplete / broken /
//           missing / preset-failed / not-found；探针：sampled / incomplete / invalid），
//           **不因清场出问题而改写**——改写它等于把一次通过的判定记成失败，
//           事后没人看得出判定本身过了。
//   ok      这次运行算不算成功。**退出码只认它**：探针的成功词是 `sampled`
//           而不是 `passed`（ADR-0015），按 status 判会把探针一律判红。
//           它还与清场、会话收尾正交：判定 passed 但清场没干净，ok 为 false，
//           退出码非零，汇总单列一行，而 status 仍是 passed。

// 重试只发生在 incomplete（见 run.mjs 的 shouldRetry）。因此 attempts 多于一条、
// 最终又通过的，就是「首次没跑完、重试通过」——它必须在汇总里点名，
// 否则重试成了掩盖，第一次红过这件事从汇总里看不出来。
export function summarizeBatch(runs) {
  const counts = {};
  for (const run of runs) counts[run.status] = (counts[run.status] ?? 0) + 1;

  const retried = runs
    .filter((run) => (run.attempts?.length ?? 0) > 1 && run.ok === true)
    .map((run) => ({
      scenario: run.scenario,
      firstStatus: run.attempts[0].status,
      attempts: run.attempts.length,
    }));

  // 判定本身过了（passed / sampled）、但这次运行不能用的条目：清场没干净、会话收尾
  // 有问题。它们不改写 status，只让退出码非零并单列。别的结论本来就非零，
  // 再单列一行「判定通过但不可用」会把一次 incomplete 说成通过了。
  const unusable = runs
    .filter((run) => (run.status === 'passed' || run.status === 'sampled') && run.ok === false)
    .map((run) => ({ scenario: run.scenario, status: run.status }));

  return {
    runs,
    counts,
    total: runs.length,
    retried,
    unusable,
    // 一条都没跑不算绿：空批次多半是路径写错，不是「全都通过」。
    exitCode: runs.length > 0 && runs.every((run) => run.ok === true) ? 0 : 1,
  };
}

// 汇总里的结论顺序固定下来：读的人按同一顺序找同一件事，不随出现顺序跳。
const SUMMARY_ORDER = [
  'passed', 'sampled', 'failed', 'invalid', 'incomplete', 'broken', 'missing', 'preset-failed',
];

export function batchSummaryLines(summary) {
  const ordered = SUMMARY_ORDER.filter((status) => summary.counts[status]);
  // 表里没列的结论（将来新增的）也不能丢：按名排在后面。
  const extra = Object.keys(summary.counts).filter((status) => !SUMMARY_ORDER.includes(status)).sort();
  const parts = [...ordered, ...extra].map((status) => `${status} ${summary.counts[status]}`);
  if (parts.length === 0) return ['批跑汇总：一条都没跑'];
  const lines = [`批跑汇总：${summary.total} 条（${parts.join('、')}）`];
  for (const entry of summary.retried) {
    lines.push(`  重试通过：${entry.scenario}（首次 ${entry.firstStatus}，第 ${entry.attempts} 次才通过）`);
  }
  // 重试也一败的条目要说清试了几次，否则读的人会以为只跑了一次。
  for (const run of summary.runs ?? []) {
    if ((run.attempts?.length ?? 0) > 1 && run.ok !== true) {
      lines.push(`  重试仍不通过：${run.scenario}（试了 ${run.attempts.length} 次，最后一次 ${run.status}）`);
    }
  }
  // 判定通过但运行本身出了问题的条目：结论没变，但这次结果不能用。
  for (const entry of summary.unusable) {
    lines.push(`  判定通过但这次运行不可用：${entry.scenario}（清场或会话收尾有问题，见它的报告）`);
  }
  return lines;
}
