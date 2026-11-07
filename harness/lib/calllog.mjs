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
