import fs from 'node:fs';

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

// 调用日志与轨迹互为校验：shim 每转发一次记一条，轨迹里每一次 PowerShell 调用都该有对应。
// 日志条数少于轨迹里的命令调用数，说明**可能**有调用绕过了 shim；但条数不等也可能是
// 非 dida 的命令（Get-ChildItem、New-Item 等）抬高了分母。判据分不清这两种，见 #18。
// 被拒绝的调用也算一条——它确实发生过，只是没转发。
export function crossCheck(calls, toolCalls) {
  const logged = calls.filter((call) => !call.unparseable).length;
  const shapeCalls = (toolCalls ?? []).filter((call) => call.name === 'PowerShell').length;
  return { calls: logged, shapeCalls, consistent: logged >= shapeCalls };
}

// 三态：判据能否给出结论。轨迹一条可解析的事件都没有时无从比较——那不是「一致」。
// 注意判的是「轨迹读不读得出来」，不是「有没有 PowerShell 调用」：一次纯 Read 的
// 会话 shapeCalls 就是 0，与日志 0 条相符，那是真的一致。
// shortcut: 仍按条数比，抓不到「总数反多」的绕过，见 #18。
export function crossCheckStatus(result, { transcriptUsable = true } = {}) {
  if (!transcriptUsable) return 'indeterminate';
  return result.consistent ? 'consistent' : 'inconsistent';
}

export function rejectedCalls(calls) {
  return calls.filter((call) => call.decision === 'rejected');
}

// 越界写入是 GLOSSARY 里的专有概念：目标清单不在测试清单集合内。
// 解析不出目标（no-target）、未知命令（unknown-command）不算越界写入，报告里要分开说。
export function outOfBoundsCalls(calls) {
  return rejectedCalls(calls).filter((call) => call.reason === 'out-of-bounds');
}
