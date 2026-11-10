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

// 调用日志与轨迹互为校验：shim 每转发一次记一条，轨迹里每一次 PowerShell 调用也该对应一条 dida 调用。
// 日志条数少于轨迹里的命令调用数，说明有调用绕过了 shim（比如直接调 dida.ps1），结论不可归因。
// 被拒绝的调用也算一条——它确实发生过，只是没转发。
export function crossCheck(calls, toolCalls) {
  const logged = calls.filter((call) => !call.unparseable).length;
  const shapeCalls = (toolCalls ?? []).filter((call) => call.name === 'PowerShell').length;
  return { calls: logged, shapeCalls, consistent: logged >= shapeCalls };
}

export function rejectedCalls(calls) {
  return calls.filter((call) => call.decision === 'rejected');
}

// 越界写入是 GLOSSARY 里的专有概念：目标清单不在测试清单集合内。
// 解析不出目标（no-target）、未知命令（unknown-command）不算越界写入，报告里要分开说。
export function outOfBoundsCalls(calls) {
  return rejectedCalls(calls).filter((call) => call.reason === 'out-of-bounds');
}
