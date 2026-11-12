# ADR-0013：shim 增加 `dida.ps1` 形态，多行参数经它保真

- 状态：接受（修订 ADR-0004「不做 `.ps1` 形态」的拒绝理由；ADR-0009 的「转发绕开 cmd」原样保留）
- 日期：2026-11-12

## 背景

ADR-0009 把 shim 的**转发**绕开了 cmd，但 `bin/dida.cmd` 仍是 agent 的第一跳：`%*` 由 cmd 展开，含换行的参数在到达 `dida-shim.mjs` 之前就被截成第一行。记账记到的即是残缺 argv，`content` 从非空变空的过程断言因此判据失真（#13，#8 依赖）。

ADR-0004 拒绝 `.ps1` 的理由是「`dida.ps1` 未签名，PowerShell 默认执行策略下直接调用 `dida` 本来就会失败」。2026-11-12 实测，这条前提在**被测会话里不成立**。

## 实测

| 事实 | 结果 |
|---|---|
| PowerShell 同目录内 `dida` 的解析 | 命中 `.ps1` 而非 `.cmd`（`Get-Command` 的 `Source` 是 `dida.ps1`） |
| `.ps1` 的 `@args` 传多行 `--content` | 保真：`["--content","line1\nline2\nline3"]` |
| `.cmd` 的 `%*` 传同样参数 | 截断：`["--content","line1"]` |
| claude 的 PowerShell 工具 | 默认带 `-ExecutionPolicy Bypass`（`CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY` 未设时），未签名脚本可跑 |
| `powershell.exe` 5.1 直接调用（无 Bypass） | 被 `AllSigned` 拒绝，且**不回落 `.cmd`**：解析到 `.ps1` 就抛 `SecurityError` |

跨目录时 PATH 顺序优先：沙箱 `bin` 前置，且 `bin` 内同目录 `.ps1` 胜过 `.cmd`。

参数长度上限（本机 Windows 10 19045，按整条命令行计）：

| 入口 | 上限 | 约合 `--items` 条数 |
|---|---|---|
| `dida.ps1`（经 shim） | 约 32760 | 约 680 条 |
| `dida.cmd`（经 shim） | 约 7900 | 约 160 条 |

`.cmd` 更窄是因为 cmd.exe 自身的输入行缓冲（8191）先于 Win32 `CreateProcess` 的 32767 触发，而 shim 壳的固定前缀已占约 250 字符。两条都不是 shim 能改的上限：前者要绕开 cmd，后者要真 CLI 支持 stdin 或文件输入，当前 `@suibiji/dida-cli@0.1.14` 不支持。

## 决定

沙箱 `bin/` 生成**两份壳**，共用同一个 `dida-shim.mjs`：

- `dida.ps1`：`node "<shim>" "<program>" "<script>" @args`，退出码透传。PowerShell 优先命中它，多行参数保真。
- `dida.cmd`：保持原样，供调用方显式写 `dida.cmd`、或用非 PowerShell 的 shell 时使用；此路多行仍截断。

**`.cmd` 不是执行策略的兜底。** 实测在 `AllSigned` 下，PowerShell 解析到 `.ps1` 就抛 `SecurityError`，不会回头去找同目录的 `.cmd`。之所以不禁用这条风险，是因为 claude 的 PowerShell 工具在 `CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY` 未设时硬编码传 `-ExecutionPolicy Bypass`，且 `sanitizeEnv` 剔除全部 `CLAUDE` 开头的变量，被测会话里该开关恒为默认。若将来这个默认改变，`.ps1` 会不可用而 `.cmd` 也不会自动接上——那时要重新评估形态。

判定、记账、转发逻辑仍只有一份（`dida-shim.mjs`），两份壳只是入口形态，不构成 ADR-0004 担心的「三份判定逻辑手工同步」。

## 后果

- 多行 `--content` 在按 skill 使用 PowerShell 的正常路径上保真，过程断言可读到完整正文。
- 显式调用 `dida.cmd`、或用绝对路径直调真 CLI 的调用，多行仍会截断；前者只会由 agent 主动写全名引起，后者本就由 `crossCheck` 标记。
- 若真 CLI 的安装形态变化（多一份 `.ps1` 同目录），沙箱内仍是我们的 `bin/dida.ps1` 优先，因为 PATH 顺序在前。
