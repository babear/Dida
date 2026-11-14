# ADR-0013：shim 增加 `dida.ps1` 形态，多行参数经它保真

- 状态：接受（修订 ADR-0004「不做 `.ps1` 形态」的拒绝理由；ADR-0009 的「转发绕开 cmd」原样保留。2026-11-14 复核：「claude 的 PowerShell 工具带 `-ExecutionPolicy Bypass`」成立、无变化，但被测会话实际用 pwsh 7 而非 5.1；另发现两个与执行策略无关的入口缺口，见文末「补充」与 #36、#37）
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

### 空串参数：只在 `.ps1` + pwsh 7 这一组合上保真

`--content ''`（清空正文的写法）会丢掉空值、保留 flag：

| 入口 | pwsh 7 | powershell 5.1 |
|---|---|---|
| `dida.ps1` | **保真**（`""`） | 丢值 |
| `dida.cmd` | 丢值 | 丢值 |

丢值时两种位置的表现：

| 写法 | 到达 shim 的 argv |
|---|---|
| `--content $empty`（末尾） | `[..., "--content"]` |
| `--content $empty --title x`（中段） | `[..., "--content", "--title", "x"]` |

也就是说，问题出在 **`.cmd` 入口**与 **5.1 的 `@args` 展开**，不是某一条入口独有。

这直接影响 #8 的过程断言规则 2：末尾那种读成「有 flag 没值」，中段那种把下一个 flag 当成 content 的值，判据都会失真。测试 `harness/lib/sandbox.test.mjs` 对 `.ps1` 的两种 shell 与 `.cmd` 都有断言，锁住现状。

### `--` 分隔符经 `.ps1` 消失

`dida task delete -- <projectId> <taskId>` 经 `.ps1` 到达 shim 时 `--` 不见了（`.cmd` 保留）。PowerShell 把 `--` 当自己的参数终止符吃掉，5.1 与 pwsh 7 都一样。

后果：`guard.mjs` 复刻的 commander 语义「`--` 之后一律当位置参数」在真实路径上永远收不到。它自己的单测直接调 `decide()`，不经过这一层，所以抓不到。与多行截断同类，是「参数在到达 shim 之前被破坏」的另一种形态，**在 #29 处理**（#29 的边界已据此修订，把 `.ps1` 入口一并纳入）。

### 值里的双引号：只有 5.1 剥掉

`--content 'say "hi"'` 经 `.ps1` 到达 shim 时：pwsh 7 保真 `say "hi"`，powershell.exe 5.1 剥成 `say hi`。`.cmd` 路径同样剥（cmd 的引号处理）。

## 决定

沙箱 `bin/` 生成**两份壳**，共用同一个 `dida-shim.mjs`：

- `dida.ps1`：`node "<shim>" "<program>" "<script>" @args`，退出码透传。PowerShell 优先命中它，多行参数保真。
- `dida.cmd`：保持原样，供 agent 显式写 `dida.cmd` 全名时使用；多行、空串值都会失真。它与 `resolveRealDidaCmd` 无关——后者解析的是 PATH 上**真** CLI 的 `dida.cmd`，不是沙箱里这份生成的壳。

**`.cmd` 不是执行策略的兜底。** 实测在 `AllSigned` 下，PowerShell 解析到 `.ps1` 就抛 `SecurityError`，不会回头去找同目录的 `.cmd`。之所以不禁用这条风险，是因为 claude 的 PowerShell 工具在 `CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY` 未设时硬编码传 `-ExecutionPolicy Bypass`，且 `sanitizeEnv` 剔除全部 `CLAUDE` 开头的变量，被测会话里该开关恒为默认。若将来这个默认改变，`.ps1` 会不可用而 `.cmd` 也不会自动接上——那时要重新评估形态。

判定、记账、转发逻辑仍只有一份（`dida-shim.mjs`），两份壳只是入口形态，不构成 ADR-0004 担心的「三份判定逻辑手工同步」。

## 后果

- 多行 `--content` 在按 skill 使用 PowerShell 的正常路径上保真，过程断言可读到完整正文。
- 显式调用 `dida.cmd`、或用绝对路径直调真 CLI 的调用，多行仍会截断；前者只会由 agent 主动写全名引起，后者本就由 `crossCheck` 标记。
- 若真 CLI 的安装形态变化（多一份 `.ps1` 同目录），沙箱内仍是我们的 `bin/dida.ps1` 优先，因为 PATH 顺序在前。

## 补充（2026-11-14）：执行策略那条结论复核

来源 [#32](https://github.com/babear/Dida/issues/32)。问的是「被测会话里 PowerShell 是不是带执行策略豁免」，跑了一次真实 `claude -p` 会话，沙箱由 `createSandbox` 真实生成、工具面用 `harness/agents.json`，原始输出见 [#32 评论](https://github.com/babear/Dida/issues/32#issuecomment-6875026097)。

### 实测

| 事实 | 结果 |
|---|---|
| `$PSVersionTable.PSVersion` | `7.7.0`（Store/MSIX 版 `pwsh.exe`，**不是** 5.1） |
| `Get-ExecutionPolicy -List` | `Process = Bypass`，其余 scope `Undefined`，`LocalMachine = RemoteSigned` |
| 未签名 `.ps1` 直接执行 | 跑起来了，无 `SecurityError` |
| `SessionState.LanguageMode` | `FullLanguage` |

### 结论：本文第 19 行与第 70 行那两条成立，没有变化

`Process = Bypass` 这个 scope 本身就是证据：机器策略是 `RemoteSigned`，`Process` 却单独是 `Bypass`，说明宿主给这个 shell **显式传了** `-ExecutionPolicy Bypass`，而不是机器恰好宽松。所以「`.cmd` 不是执行策略的兜底」这个风险前提仍然成立，不需要改决定。

距离 2026-11-12 原文的变化只有一处：**被测会话的 shell 是 pwsh 7，不是 5.1。**

### 由此带来的读者须知：5.1 那两节说的不是被测路径

上文「空串参数」与「值里的双引号」两节，把 `powershell.exe` 5.1 的失真写成了重要结论（5.1 丢空串值、5.1 剥双引号）。按本文自己的表，这两项**在 pwsh 7 经 `.ps1` 都是保真的**，而被测会话正是 pwsh 7——所以：

- 那两节**不是错的，也不是多余**：`harness/lib/sandbox.test.mjs` 仍锁着两种 shell 的行为，是边界记录；
- 但它们**不再命中真实评测路径**。#8 规则 2（`content` 从非空变空）在这条路径上不受它们影响；
- 原文按「修订保留原文、另加补充」的惯例**未改动**，读者以本段为准。

### 两个与执行策略无关的入口缺口

复核过程中撞出两件更要紧的事，都**不在本文决定的范围**，已各自另开：

- **#36**：`run.mjs` 在 Windows 上因 `Path` / `PATH` 大小写重复键丢掉继承的 PATH，沙箱里裸 `node` 找不到，`dida` 全挂。
- **#37**：会话一旦拿到 Bash 工具，MSYS 跳过 `bin/` 里的 `.ps1` 与 `.cmd` 直连真 CLI，判定与记账全部失效（实测 `calls.ndjson` 未生成）。

**#37 动摇的是本文「两份壳覆盖全部入口」这个隐含前提**，而不是「`.ps1` 保真」这条结论。当前会话之所以「一直在 PowerShell 上」，是 #36 那个 PATH bug 的副作用（探测不到 Git Bash → PowerShell 工具才启用），不是设计。
