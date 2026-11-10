# ADR-0004：shim 用单份 `.cmd` 透明转发，不用 PowerShell 脚本

- 状态：接受（2026-11-07 修订：转发方式改为 node 脚本直接调 CLI 入口，`%*` 会把含换行的参数截断；形态仍是单份 `.cmd`。见 ADR-0009。2026-11-10 修订：越界写入判定已实现，解析规则以 ADR-0011 为准，拒绝状态码改为 404）
- 日期：2026-11-06

## 背景

越界写入必须"根本发不出去"，而不是事后核对。候选做法是 `PATH` 前置一个同名 `dida` 中间层，把目标清单不是测试清单的写命令拒掉。

本机 Windows 10 上，真 `dida` 有三种可执行形态：`dida`（无后缀 shell 脚本）、`dida.cmd`、`dida.ps1`。而被测 agent 唯一能执行命令的工具是 `PowerShell`——`--tools "Bash"` 在本机会得到空工具列表。

实测三条关键事实：

1. `dida.ps1` 未被数字签名，PowerShell 默认执行策略下直接调用 `dida` **本来就会失败**（这也是 skill 文档里写着"执行策略拒绝时改用 `dida.cmd`"的由来）。
2. 当 `PATH` 前置目录里放一个 `dida.cmd`，PowerShell 解析 `dida` 时会命中它，**即使真安装目录里有 `dida.ps1`**。
3. 用回显式的假 CLI 拦截时，被测 agent 会 `Get-Command dida`、读脚本内容，并直接指出"这不是真正的 CLI"。改为透明转发（记账后 `& dida.cmd @args`）后，agent 全程未察觉。

## 决定

**只做一份 `dida.cmd`**，内容为：判定并记账，然后原样转发给真 `dida.cmd`，退出码透传。不做 `.ps1` 形态，不做 bash 形态。

拒绝越界写入时，输出与真 CLI 同构的 `DIDA API 错误 404: {...}` 文本和退出码 1，不暴露测试机制。转发时吞掉真 CLI 在错误路径上打出的一行 Node 断言（`Assertion failed: ... UV_HANDLE_CLOSING`）。

## 考虑过的方案

- **`.ps1` 形态**：优先级更高，但 PowerShell 默认执行策略会拒绝加载未签名脚本，需要被测会话里有人传 `-ExecutionPolicy Bypass`，而 agent 未必会传。
- **三份形态并存**：覆盖所有入口，但三份判定逻辑要手工同步，必然漂移。
- **回显式 mock**：实现最省事，但实测会被 agent 识破，行为失真。

## 后果

- 若以后放开 bash 入口，需要补一份无后缀形态。
- shim 是进程级拦截，不依赖 Claude Code 的 hook 机制，因此在任何隔离配置下都有效。
