#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

import { appendCall } from './lib/calllog.mjs';
import { recordCreated } from './lib/created.mjs';
import { classify } from './lib/shim.mjs';

// 形参由 sandbox 生成 bin/dida.cmd 时注入：<node 可执行> <真 CLI 脚本> <用户传入的 argv...>
const [program, script, ...argv] = process.argv.slice(2);

const callLogPath = process.env.DIDA_CALL_LOG;
const createdFile = process.env.DIDA_CREATED_FILE;

if (!program || !script) {
  console.error('shim 没有拿到真 CLI 的入口；拒绝在缺少转发目标时运行');
  process.exit(1);
}
if (!callLogPath || !createdFile) {
  console.error('shim 缺少 DIDA_CALL_LOG / DIDA_CREATED_FILE；不能在没有账本的情况下转发');
  process.exit(1);
}

const kind = classify(argv);

// 记账在转发之前：真 CLI 崩掉也要留下"这次调用发生过"的事实。
appendCall(callLogPath, { argv, kind, at: new Date().toISOString() });

// 直接 spawn node + 脚本，不经 cmd 二次解析：argv 含换行、引号、%VAR% 都能原样到达被测 CLI。
const result = spawnSync(program, [script, ...argv], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

const stdout = result.stdout ?? '';
const stderr = result.stderr ?? '';
process.stdout.write(stdout);
process.stderr.write(stderr);

// recordCreated 自己只认 task create 且成功的调用；其它调用原样略过。
recordCreated(createdFile, { argv, stdout, exitCode: result.status ?? 1, stderr });

process.exit(result.status ?? 1);
