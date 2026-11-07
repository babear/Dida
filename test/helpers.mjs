import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(t, prefix = 'harness-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
