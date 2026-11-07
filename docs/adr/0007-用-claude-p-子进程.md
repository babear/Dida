# ADR-0007：用 `claude -p` 子进程而非 Agent SDK 或 plugin eval

- 状态：接受
- 日期：2026-11-06

## 背景

三条候选技术路线：

- `claude plugin eval`：官方行为评测 harness，每 case 起一个隔离的 `claude -p`，断言方式含 `tool_used` / `input_match`，还有无 plugin 的对照组。
- Claude Agent SDK：类型化消息、程序化 hooks、`settingSources: []` 精确控制。
- `claude -p --output-format stream-json`：直接起子进程、解析 NDJSON。

## 决定

**用 `claude -p` 子进程 + 解析 `stream-json`。**

## 考虑过的方案

`plugin eval` 被否掉有两条硬原因：授予 `Bash` 后每条命令必须在 OS 级 sandbox 中运行，而原生 Windows 没有 sandbox 后端，官方要求迁移到 WSL2；且它没有自定义代码 grader，无法断言 DIDA 远端的真实状态——而本项目的核心恰恰是"任务最终写成了什么样"。

Agent SDK 被推迟而非否定：类型化消息与程序化 hooks 确实更好，但需要 API key 认证，而本机认证是本地代理（`ANTHROPIC_AUTH_TOKEN=PROXY_MANAGED` + `ANTHROPIC_BASE_URL`），SDK 走不通这条路；且当前规模不需要 session 恢复等能力。若将来迁到 Linux CI 或需要跨平台，再切换。

## 后果

- 需要自行解析 NDJSON、自行清理继承来的 `CLAUDE*` 环境变量、自行处理进程生命周期。
- `claude -p` 在 stdin 未关闭时会等待输入并挂死，所有调用必须显式重定向 `< /dev/null`。
- `--max-turns` 在本机 CLI 上被接受但**无效**（实测传 2 实跑 6 轮），轮数护栏只能由 harness 侧看门狗实现。
- `--max-budget-usd` 是硬中断，但会在上一个调用结束后才触发，实测 $0.05 限额实花 $0.111；且中转账单与本机估算金额存在出入，报告里的美元数字只能作为量级参考。
