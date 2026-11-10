#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

import { appendCall } from './lib/calllog.mjs';
import { recordCreated } from './lib/created.mjs';
import { decide, rejectText, stripNodeAssertion } from './lib/guard.mjs';
import { TEST_PROJECTS } from './lib/guard-config.mjs';

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

// 测试清单集合来自沙箱里烘焙好的 guard-config.mjs，不读环境变量：
// 被测 agent 能读也能改进程环境，从 env 读白名单等于把判定权交给它。
// 集合为空时 decide 会拒绝一切需要目标的写命令（没有可判定的边界就不放行），读命令照常转发。
const verdict = decide(argv, TEST_PROJECTS);

// 记账在转发之前：真 CLI 崩掉、或被拒没转发，都要留下"这次调用发生过"的事实。
appendCall(callLogPath, {
  argv,
  at: new Date().toISOString(),
  decision: verdict.allow ? 'allow' : 'rejected',
  ...(verdict.allow ? {} : { reason: verdict.reason, targets: verdict.targets }),
});

if (!verdict.allow) {
  // 用 exitCode + return 而不是 exit()：Windows 管道上立刻 exit 会把 stderr 截断。
  process.stderr.write(`${rejectText({ id: verdict.targets[0] })}\n`);
  process.exitCode = 1;
} else {
  // 直接 spawn node + 脚本，不经 cmd 二次解析：argv 含换行、引号、%VAR% 都能原样到达被测 CLI。
  const result = spawnSync(program, [script, ...argv], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const stdout = result.stdout ?? '';
  // 真 CLI 在错误路径上退出时会带一行 libuv 断言；转发时吞掉，否则 agent 会看到进程内部信息。
  const stderr = stripNodeAssertion(result.stderr ?? '');
  process.stdout.write(stdout);
  process.stderr.write(stderr);

  // recordCreated 自己只认 task create 且成功的调用；其它调用原样略过。
  recordCreated(createdFile, { argv, stdout, exitCode: result.status ?? 1, stderr });

  process.exitCode = result.status ?? 1;
}
