import fs from 'node:fs';

import { compareInvocations } from './powershell.mjs';

export function parseCallLog(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ unparseable: true, raw: line });
    }
  }
  return entries;
}

export function writeCallLogEntry(sink, record) {
  sink.append(`${JSON.stringify(record)}\n`);
}

export function appendCall(callLogPath, record) {
  writeCallLogEntry({ append: (line) => fs.appendFileSync(callLogPath, line) }, record);
}

// 调用日志与轨迹互为校验：shim 每转发一次记一条，轨迹里每一次 dida 调用都该有对应。
// 判据是**逐调用比对命令内容**，不比条数（#18）：条数比抓不到「3 次调用里 1 次绕过、
// 另 2 次各跑 2 条 dida」——总数反多，`logged >= shapeCalls` 仍成立。反过来，
// 工具面没有 Bash，agent 的任何文件操作都必须走 PowerShell，条数比会把它们算进分母，
// 一次 Get-ChildItem 就足以让一次真实回归变成什么结论都拿不到（ADR-0014 后果）。
//
// 被拒绝的调用也算一条——它确实发生过，只是没转发。
export function crossCheck(calls, toolCalls) {
  const checked = compareInvocations(toolCalls, calls);
  return {
    status: checked.status,
    unmatched: checked.unmatched,
    reason: checked.reason ?? null,
  };
}

// 三态：判据能否给出结论。轨迹一条可解析的事件都没有时无从比较——那不是「一致」。
// 注意判的是「轨迹读不读得出来」，不是「有没有 PowerShell 调用」：一次纯 Read 的
// 会话没有 dida 调用，与日志 0 条相符，那是真的一致。
export function crossCheckStatus(result, { transcriptUsable = true } = {}) {
  if (!transcriptUsable) return 'indeterminate';
  return result.status;
}

export function rejectedCalls(calls) {
  return calls.filter((call) => call.decision === 'rejected');
}

// 越界写入是 GLOSSARY 里的专有概念：目标清单不在测试清单集合内。
// 解析不出目标（no-target）、未知命令（unknown-command）不算越界写入，报告里要分开说。
export function outOfBoundsCalls(calls) {
  return rejectedCalls(calls).filter((call) => call.reason === 'out-of-bounds');
}
