# dida-cli skill 项目

一个 Claude Code skill 的技能仓库，用真实 agent 会话验证 skill 文档能否让 agent 正确使用 `dida` CLI。

## Language

**Skill 包**:
本仓库的被测对象，即 `skills/dida-cli/` 下的 Markdown 文件集合（`SKILL.md` + `references/`）。
_Avoid_: 技能、prompt、文档

**Scenario**:
一条可执行的测试用例，由用户原话、沙箱素材、可选预设和断言组成。一条 scenario 对应一个或多个已确认的 skill 缺陷。
_Avoid_: 测试、case、用例

**被测 agent**:
harness 为每条 scenario 启动的一次性 `claude -p` 子进程，它只能看到用户原话和沙箱素材。
_Avoid_: 子 agent、测试 agent、worker

**判定 agent**:
在被测 agent 结束后读取其轨迹、给出质量评分的独立会话。它不参与判定通过或失败。
_Avoid_: 评委、judge（除非指代码模块 `judge.mjs`）

**轨迹**:
被测 agent 一次会话产生的 `stream-json` NDJSON 原文，包含每次工具调用的入参与结果。
_Avoid_: 日志、log、trace（除非指文件名 `trace.ndjson`）

**调用日志**:
shim 记下的 `dida` 调用序列，`runs/<runId>/calls.ndjson`，每行一条 `{argv, at, decision}`，其中 `argv` 是解析后的数组而非命令字符串；被拒的另带 `reason` 与 `targets`。它是过程断言的独立事实源，与轨迹互为校验。
_Avoid_: 记录、shim 日志

**工具面**:
被测 agent 启动时被授予的工具名集合。本项目的工具面是 `Skill`、`PowerShell`、`Read`、`Glob`、`Grep`、`Write`。
_Avoid_: 工具箱、权限、allowedTools（除非指命令行参数）

**shell**:
执行命令的交互式解释器，本机有 `pwsh`、`cmd`、`bash` 三种。shell 不是工具，它在工具面里没有独立条目。
_Avoid_: 终端、命令行

**可执行形态**:
同一条命令的不同可执行文件，如 `dida.cmd`、`dida.ps1` 与无后缀的 `dida`。shim 的形态是 `.cmd`。
_Avoid_: 版本、变体、入口

**shim**:
`PATH` 前置目录里的同名 `dida` 可执行文件（形态为 `.cmd`），由工具面上的 `PowerShell` 调用，透明转发给真 CLI，同时记账并拒绝越界写入。
_Avoid_: mock、桩、代理、wrapper

**调用方标记**:
每次运行追加到沙箱 skill 副本 `SKILL.md` 末尾的 `HARNESS-CALLER-MARKER-<runId>`，同时写入 manifest，用来证明被测 agent 读到的是沙箱副本而非全局软链接。
_Avoid_: 水印、witness

**测试清单**:
`Test_1`（`69abc459ebbdbd00000009f0`）与 `Test_2`（`59f736cae4b060e424059e3b`）。所有写入必须落在其中之一。这份集合同时供 shim 判定越界写入与清场使用。
_Avoid_: 沙箱清单、测试项目

**账本**:
`runs/<runId>/created.ndjson`，本 run 建成并**建一条即记一条**的任务记录（NDJSON，一行一条：`id` / `projectId` / `title`）。它是这条 scenario 的**唯一事实源**——断言读它，清场删它。清单里的其它任务不在这个视野里（见 ADR-0010）。
_Avoid_: created.json、任务清单、删除列表、白名单

**清场**:
一次运行结束后，按账本删除本 run 创建的任务。清单里其它任务一概不碰——不检测、不报告。永不完全清空清单（见 ADR-0006、ADR-0010）。
_Avoid_: 清理、打扫、重置、reset

**越界写入**:
目标清单不在测试清单集合内的任何写操作。shim 在转发前判定并当场拒绝，写请求不发出去；被拒的调用记进调用日志（`decision: rejected`），不写账本（见 ADR-0011）。
_Avoid_: 误写、非法操作

**结局断言**:
会话结束后对测试清单最终状态的判断，决定 scenario 的通过或失败。
_Avoid_: 结果断言、state check

**过程断言**:
对调用日志中调用序列的判断。只覆盖已确认的硬规则，与结局断言共同决定通过或失败。只读调用日志，不读轨迹。
_Avoid_: 行为断言、调用断言

**可信度检查**:
对调用日志条数与轨迹里命令调用数的比对，判断一个 run 的结果是否可归因；少于即说明有调用绕过 shim。失败时该 run 标为无效而不是失败。
_Avoid_: 一致性检查、交叉校验

**预设**:
建沙箱之前由 harness 直接对测试清单执行的建任务命令，用来造出 scenario 需要的前置数据。它在沙箱之外执行、不经 shim，建出的任务与 shim 记的走同一份账本。
_Avoid_: 初始化、fixture、setup

**探针**:
一条还没写断言的 scenario。跑一次真实会话，产出轨迹、调用日志与终态快照供人据此写断言，跑完即删。
_Avoid_: 试验、试跑、probe 模式

**终态快照**:
`runs/<runId>/state.json`，账本里每个 id 取回的任务现状，取不到的记 `null`；在清场之前取，供结局断言读，也供断言改了之后重放。
_Avoid_: 状态文件、快照

**复现价**:
一条 scenario 在修改 skill 之前必定失败的证据，由基线运行产生。
_Avoid_: 红、red、baseline（除非指文件名 `baseline/`）
