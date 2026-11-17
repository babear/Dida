# harness

被测 agent 会话的启动器。每条 scenario 在一个新建的运行目录里起一个 `claude -p` 子进程，把它的原始轨迹落盘到 `runs/<runId>/`。

## 跑

```bash
node harness/run.mjs --scenario <id>
npm run test:harness  # harness 自己的单元测试，不烧 API
```

`npm run test:harness` 跑与被测文件同目录的 `*.test.mjs`。`npm run test:scenarios` 跑 `skill-tests/` 下的用例自检（断言的构造数据测试，不烧 API）。跑 scenario 本身要真实 API 会话，别名归 #9。

| 参数 | 默认 | 作用 |
|---|---|---|
| `--scenario <id>` | 全部 | 只跑 `skill-tests/scenarios/<id>/` 这一条；id 也可命中 `probes/<id>/`（同名时正式用例优先） |
| `--skill-path <dir>` | `skills/dida-cli` | 要复制进运行目录的 skill 目录 |
| `--settings <file>` | `~/.claude/settings.json` | 取 `ANTHROPIC_*` 键的来源 |
| `--keep-sandbox` | 关 | 成功时也保留运行目录（失败时总是保留）。只管运行目录，不影响清场 |
| `--hold` | 关 | 跑完不清场，留现场给人看；之后用 `--clean <runId>` 收尾 |
| `--clean <runId>` | — | 只按该 run 的 `created.ndjson` 删除任务，然后退出。**不改写 `report.md`，也不覆盖 `manifest.cleanup`**——那份报告与当时的结论是那次运行的产物，收尾只把结果记到 `manifest.cleanupAfter` |

退出码：任一 scenario 断言未通过、会话非零退出或超时、用例配置错误（缺 `assert.mjs`，或断言模块加载失败、没给出合法结果）、预设失败（越界、指向已有任务、空操作、执行失败）、可信度检查不过（有 dida 调用没进日志，或轨迹读不出可比的调用）、终态快照取不到、清场中止或删除失败，都是 1。

### 清场纪律

**一条 scenario 的全部事实源是 `created.ndjson`。** 断言读它，清场删它。清单里的其它任务不在这个视野里——不检测、不报告、不碰（见 ADR-0010）。

1. **只删账本里记录的 id**。shim 每建成一条任务就追加一行（NDJSON，并发安全），清场只按这份账本删。
2. **删除目标取实际枚举到的清单**，不用账本里记的 `projectId`；两者不一致时报 `mismatched`，仍按实况删。
3. **清场失败不中断后续 scenario**。账本按 runId 隔离，删不掉自己的那几条不影响下一条。失败记 log，退出码非零。
4. **清场后自查**：删完重读清单，账本里的 id 仍在就报 `remaining`。

现场保留：运行目录、`runs/<runId>/` 与**本 run 建的任务**都不动。确认完用 `--clean <runId>` 收尾。**只有 `PASSED` 才自动清场**；会话没正常结束、可信度失败、任一断言面不过都保留现场（见 ADR-0014）。`--hold` 让通过的运行也保留。

### 环境变量

两个逃生口，在自动探测失败时使用：

| 变量 | 作用 |
|---|---|
| `CLAUDE_EXE` | `claude` 可执行文件路径。不设时依次尝试 `<node 目录>/node_modules/@anthropic-ai/claude-code/bin/claude.exe`、`<node 目录>/../node_global/…`、`npm prefix -g` 下的同一路径；全都找不到则报错退出 |
| `DIDA_CMD` | 真 `dida.cmd` 的绝对路径。不设时从 `PATH` 里找第一个 `dida.cmd`；找不到则报错退出（不会退化成自递归 shim） |
| `DIDA_TEST_PROJECTS` | 测试清单 id，逗号分隔。不设时用 `Test_1` 与 `Test_2`（见 `harness/lib/projects.mjs`）。覆盖成空值会退回默认。`run.mjs` 把它烘焙进运行目录的 `shim/lib/guard-config.mjs` 而不注入子进程环境；shim 也不读这个变量（操作者环境里若设了它，`sanitizeEnv` 会照常透传，但判定不受影响） |

## scenario

`skill-tests/scenarios/<id>/` 一个目录就是一条 scenario：

| 文件 | 作用 | 被测 agent 看得到 | 实现 |
|---|---|---|---|
| `scenario.json` | `prompt`，唯一给 agent 的文本输入 | 是 | 已有 |
| `materials/` | 可选，整体复制进运行目录的 `work/materials/` | 是 | 已有 |
| `preset.mjs` | 可选，声明要建的任务，会话前由 harness 用真 CLI 执行 | 否 | 已有 |
| `assert.mjs` | 结局断言，默认导出 `{tasks, created, calls, session} => 结果数组` | 否 | 已有 |

加一条 scenario 就是加一个目录，harness 一行不用改（前提是 `assert.mjs` 与 `preset.mjs` 已实现）。目录形态与三面判定的完整理由见 ADR-0012。

**`scenario.json`、`materials/`、`preset.mjs` 与 `assert.mjs` 都能跑。**

`preset.mjs` 建前置数据时从 harness 拿到**本次 run 的清单**，不是仓库里的默认常量——用默认常量会在环境变量覆盖时建到清场的视野外，成为删不掉的孤儿。校验规则见 ADR-0012：目标清单必须 ∈ 本次清单集合；指向已有任务的参数（`--parent-id`、`task update --id` 等）与 `--help` 这类空操作一律拒绝。它建出的任务立刻记进本 run 的账本（`origin: 'preset'`），和 shim 记的是同一份。

`preset.mjs` 的三条硬规则：

1. **默认导出一个函数**，harness 把本次清单传进去：`export default (projects) => [['task', 'create', '--project', projects[0], '--title', '买气罐']]`。
2. **整体校验先于执行**：任一条越界、指向已有任务、不是 `task create`、或是空操作（`--help`、裸命令组、只读命令）就拒绝该 run，一条都不执行、不建运行目录、不进入会话。只放行 `task create` 是因为账本只记得下它建出的任务 id——别的写命令改了真实数据却清不回来。
3. **失败不清场**：建出的任务留在 `runs/<runId>/created.ndjson`，用 `--clean <runId>` 收尾。预设只造数据结构，不造语义提示。

`assert.mjs` 返回 `{ok, name, expected, actual}[]`，空数组即通过。它按**字段**定位任务（`childIds.length === 5`、`kind === 'TEXT'`），不按顺序猜。`created` 条目带 `origin: 'preset' | 'agent'`。

**`scenarios/<id>/` 缺 `assert.mjs` 时报错退出，不跑会话。** 跳过会让漏写或误删断言的用例静默退出回归网、退出码仍是 0。报告里单列「用例配置错误」，与「断言未通过」区分——一个去补用例，一个去改 skill。没写完的用例放 `probes/`。

### 探针

`skill-tests/probes/<id>/` 是探针。它与 scenario **共用**运行目录、会话、账本、调用日志、会话门与可信度检查，**分岔在取到终态快照之后**：探针到此结束，不跑结局断言与过程断言，也永不清场（见 ADR-0015）。

| 维度 | scenario | 探针 |
|---|---|---|
| 会话门 / 可信度检查 | 都要过 | 都要过 |
| 取终态快照 | 取 | 取，到此为止 |
| 结局断言、过程断言 | 跑 | 不跑 |
| 结论 | `passed` / `failed` / `broken` / `invalid` / `incomplete` | `sampled` / `invalid` / `incomplete` |
| 清场 | 只有 `passed` 才清 | **永不**，收尾用 `--clean <runId>` |
| manifest | `kind: 'scenario'` | `kind: 'probe'` |

- 退出码只反映「这份样本可不可用」：`sampled` 为 0，其余为 1。
- 探针的空样本（agent 一条任务都没建、`state.json` 落 `[]`）仍是 `sampled`——那正是要写进断言的事实。
- `probes/<id>/` 里的 `assert.mjs` 不执行，控制台与报告各留一行提示。
- 探针可以带 `preset.mjs`，校验规则与账本归属同 scenario。
- 全量运行只扫 `scenarios/`，不碰 `probes/`；跑完时 `probes/` 非空会在汇总末尾提醒清理。
- 同名时正式用例优先：`scenarios/<id>` 赢过 `probes/<id>`。
- **跑前清场**：开跑某条用例之前，若它上一次的 run 没清场，先按那份账本清一遍。探针不清场是设计，留下的任务会让下一次运行的 agent 看到同名任务就不再新建，取样直接失真（2026-11-17 实际发生过）。
- **报告标题行标明身份**：`# 探针 <id> · <run>` 与 `# scenario <id> · <run>`，不用翻 manifest 就能分清。

`listScenarios` 只扫 `skill-tests/scenarios/`，仓库根的旧 `scenarios/` 已不再读取。

## 判定

**会话正常结束是前置门，不属于三面。** 会话没正常结束（退出码非 0 或超时）时判定链根本没开始：不取快照、不跑任何断言，落 `INCOMPLETE`。

三面按**严格顺序**短路，前一面不过就不算后面，任一面红即非零，报告写明是哪一面。**没有「评估」**——不存在「算了但不计入判定」的结论，报告里只出现第一个红的面（见 ADR-0014）：

1. **可信度检查**：从轨迹里每次 `PowerShell` 调用的命令字符串中抽出 dida 调用，与调用日志的 argv 逐条对；对不上的那几次就是没走过 shim。与 dida 无关的命令（`Get-ChildItem`、`New-Item` 等）不参与判断；轨迹读不出事件、或命令里出现 dida 却解析不出（如 `$cmd = "dida"; & $cmd task create`）则判无从比对。三态：`consistent` / `inconsistent` / `indeterminate`，后两种都标 `invalid` 而非 `fail`——退出码同样非零，但语义是"结果不可用"，不是 skill 有缺陷。**不过即终止，不取快照、不跑断言。**
2. **取快照 ＋ 结局断言**：读终态快照 `runs/<runId>/state.json`——账本里每个 id 取回的任务现状，取不到的记 `null`。定位与清场同一套：先按测试清单枚举再按 id 找，因为 agent 可能用 `task move` 挪走任务；枚举不到才回退到账本记的 `projectId` 直查。快照在断言这一刻取，不在会话结束时取。
3. **过程断言**：调用日志 argv 序列上的三条硬规则，见 ADR-0005。第 3 条（越界写入）现由 shim 当场拒绝并记 `rejected`，只需接进判定。

**顺序**：会话是否正常结束 → 可信度检查 → 取快照 ＋ 结局断言 → 过程断言。除 `PASSED` 外退出码都是 1。

| 结果 | 含义 | 怎么修 |
|---|---|---|
| `PASSED` | 三面全过 | — |
| `FAILED` | 断言未通过，skill 没做到 | 改 skill |
| `BROKEN` | 断言模块没给出合法结果（抛异常、返回非数组、元素缺布尔 `ok`、稀疏数组），用例有缺陷 | 改用例 |
| `INVALID` | 结果不可用，三种原因：终态快照取不到 / 调用日志与轨迹对不上 / 轨迹读不出 | 快照失败→重跑；后两者→先查明原因，重跑不一定有用 |
| `INCOMPLETE` | 会话没正常结束，判定链未开始（不取快照、不跑断言） | 看退出码与轨迹，查会话为什么没跑完 |
| `MISCONFIGURED` | 缺 `assert.mjs`，不开会话但仍落一份只含判定的报告 | 补用例，或移到 `probes/` |
| `PRESET FAILED` | `preset.mjs` 越界、指向已有任务、空操作或执行失败：不建运行目录、不开会话、不清场 | 改 `preset.mjs`；已建的任务用 `--clean <runId>` 收尾 |
| `NOT FOUND` | `--scenario` 写错 id | 改正 id |

过程断言归 #8。可信度判据已于 #18 从「比条数」改为逐调用比对：轨迹里的 dida 调用与调用日志逐条对，与 dida 无关的 PowerShell 命令不参与判断。

## 运行目录

建在 `%TEMP%/run-<runId>/`，**不放在仓库内**：仓库子目录会继承父目录的 `CLAUDE.md` 与 `.claude/skills/`，后者的同名 skill 会与运行目录里的副本竞争。

```
run-<runId>/
├── work/                  # ← 被测 agent 的 cwd。只放它该看的
│   └── materials/         # scenario 素材（若有）
├── config/                # ← CLAUDE_CONFIG_DIR。不在 cwd 里
│   ├── settings.json      # 只含源 settings.json 的 ANTHROPIC_* 键
│   └── skills/dida-cli/   # 从 --skill-path 整体复制，末尾追加调用方标记
├── agents.json            # 从 harness/agents.json 复制，--agents 指这里
└── shim/                  # 前置到 PATH 的 shim：dida.ps1 + dida.cmd + dida-shim.mjs + lib/
```

**只有 `work/` 是 cwd。** shim、配置、工具面定义都在它的上一层——agent 的 `Get-ChildItem` 看不到它们，但仍通过 `PATH`、`CLAUDE_CONFIG_DIR`、`--agents` 正常生效（见 #16）。

`harness/agents.json` 是 `--agents` 的定义文件，在仓库里，有 diff、能 review、能回滚（选 `--agents` 的理由见 `docs/specs/dida-cli-skill-评测平台.md` 的「会话启动契约」）。运行时原样复制进运行目录，不在代码里拼装。

会话以 `work/` 为 `cwd`、`CLAUDE_CONFIG_DIR` 指向 `config/` 启动，并从父进程环境里剔除全部以 `CLAUDE` 开头的变量。实测这样只暴露 `config/skills/` 里那一份 skill，`~/.claude/skills/` 下的同名软链接不参与竞争。

**`settings.json` 必须留在 `config/` 里。** 实测把 `CLAUDE_CONFIG_DIR` 指到只有 `skills/`、没有 `settings.json` 的目录时，`~/.claude/settings.json` 不会回退生效，会话直接判 `Not logged in`——配置目录是一个整体开关，没有"只换 skill 不换 settings"的粒度。

## 调用方标记

每次运行在运行目录副本的 `SKILL.md` 末尾追加一段 `## 调用方标记`，内容为 `HARNESS-CALLER-MARKER-<runId>`，同时写进 manifest 的 `callerMarker`。

它是"agent 读的确实是运行目录里的副本"的可核对凭据：在 `trace.ndjson` 里搜到该标记、而全局软链接那份里没有，就排除了"测的是主仓库旧版本"。

## 会话启动契约

- `--agents` + `--agent dida-scenario`：工具面 `Skill`、`PowerShell`、`Read`、`Glob`、`Grep`。`--allowedTools` 必须同时给，否则 `dontAsk` 会拒掉所有命令。
- stdin 重定向到 `ignore`（即 `/dev/null`）。不关 stdin 时 `claude -p` 会等输入并挂死。
- `--output-format stream-json --verbose` 写 `trace.ndjson`，`--no-session-persistence` 避免落进用户目录。
- 环境：`sanitizeEnv` 剔除从父进程继承的全部 `CLAUDE` 开头变量，再显式设回 `CLAUDE_CONFIG_DIR`。**这不是完整的环境隔离**——CLI 会自行注入 `CLAUDECODE`、`CLAUDE_CODE_SESSION_ID` 等一批变量，与父进程传不传无关，清单与含义见 ADR-0008 的后果段。写断言时不要假设子进程环境干净。
- 超时上限 15 分钟，超时后杀子进程并标 `timedOut`，运行目录保留。只杀直接子进程，尚未杀进程树——看门狗属于 #11。

## shim

运行目录的 `shim/` 下有这些文件（不在 agent 的 cwd 里，只经 PATH 暴露）：

- `dida.ps1`：一行 PowerShell 壳，`node dida-shim.mjs <node 可执行> <真 CLI 脚本> @args`。PowerShell 同目录内优先命中它，`@args` 原样展开，多行参数保真。
- `dida.cmd`：一行 shell 壳，`node dida-shim.mjs <node 可执行> <真 CLI 脚本> %*`。供 agent 显式写 `dida.cmd` 全名时使用；这一路的多行与空串值都会失真。
- `dida-shim.mjs`：判定 + 记账 + 转发。
- `lib/`：shim 用到的模块（`calllog.mjs`、`created.mjs`、`guard.mjs`，以及 `calllog.mjs` 转手引入的 `powershell.mjs`），外加建运行目录时烘焙的 `guard-config.mjs`（测试清单集合）。

**为什么不是 `CALL "<真 dida.cmd>" %*`**：实测 `.cmd` 的 `%*` 转发在含换行的参数上会截断到第一行，`%VAR%` 也会被展开。改成从真 `.cmd` 里解析出 node 与脚本入口后直接 spawn，argv 由 `CreateProcess` 原样传递，空格、引号、中文、`|`、`&`、`%` 都保真。解析不到入口时直接报错，不降级成自递归。

**记账**：每次调用在判定**之后**、转发**之前**追加一行到 `runs/<runId>/calls.ndjson`，内容为 `{argv, at, decision}`；被拒时另带 `reason` 与 `targets`（越界的那几个清单 id）。被拒的调用也记一条——它确实发生过。`task create` 成功后从 stdout 抠出任务 id（`ID: <24 位十六进制>` 或 `--json` 的对象），追加到 `runs/<runId>/created.ndjson`（一行一条）。

### 越界写入防护

**一条规则：对写命令解析目标清单；解析不出目标、或目标不在测试清单集合内，就拒绝。** 写请求根本不会发出去（见 ADR-0011）。

| 命令 | 目标清单来源 |
|---|---|
| `task create` / `task update` | `--project`；`update` 还要求位置参数 `<taskId>` 与 `--id` 相同 |
| `task move` | `--from` 与 `--to`（可重复、可多值），任一越界即拒 |
| `task complete` / `delete` / `comment add` / `comment delete` | 位置参数 1 |
| `task assign` / `unassign` / `complete-batch` | `--project` |
| `project update` / `delete` / `column create` / `column update` | 位置参数 1 |

其余写命令（`project create`、`project group *`、`habit *`、`focus *`、`tag *`、`auth login/logout/token`）没有可判定的目标清单，**一律拒绝**。读命令放行；既不在写表也不在读表的命令按未知拒绝，不默认放行。

- 拒绝时 stderr 一行 `DIDA API 错误 404: {...}`（`resource_not_found`，`errorId` 每次随机），stdout 为空，退出码 1——与真 CLI 在 API 失败时的形态一致，不暴露这是评测环境。
- 测试清单集合在生成运行目录时烘焙进 `shim/lib/guard-config.mjs`，**不从环境变量读**：被测 agent 能读能改进程环境，从 env 读白名单等于把判定权交给它。
- **运行目录分两块，只有 `work/` 是 agent 的 cwd**（#16）：`work/` 里只有 `materials/`；shim 在 `shim/`、skill 与 settings 在 `config/`、工具面定义在 `agents.json`，三者都在 `work/` 的上一层。实测 agent 在 cwd 里看到 `bin/` 与 `.claude/` 就会去翻（`Get-ChildItem -Force -Recurse materials, .claude, bin`、`Get-Content agents.json`），看不到就不会。挪出去不是安全边界——agent 有 `PowerShell`，绝对路径仍读得到（#3）——而是把"无意看到"这条路径去掉，实测里那正是唯一发生的。
- 工具面去掉了 `Write`：当前没有 scenario 需要写文件，而它能直接覆写越界防护的白名单。
- 曾试过给 shim 与白名单加 Windows ACL deny 并做会话前后指纹比对，最终撤掉：实测 agent 用 `icacls <file> /remove:d <user>` 一行就能解除，解除后覆写、越界调用照常发生（与 #16 的复现逐字一致）。它防不住有意绕过，却带来锁死运行目录的风险。真正的边界要等 #3 的执行模型方案。
- 只给到命令组（`dida task`、`dida project group`）或接在组名后的 `help`（`task help`、`project group help`）只打印用法，照常放行。
- 转发时把真 CLI 错误路径上那行 `Assertion failed: … UV_HANDLE_CLOSING` 滤掉。
- 参数解析复刻 commander 语义：`--flag=value`、flag 夹在位置参数中间、`--` 之后一律当位置参数、重复 flag 全部校验、`--project=` 空值视为解析不出目标。
- 写命令缺 `--project` 时错误文本与真 CLI 不同（真 CLI 报 required option），两条路都写不出去。

**已知边界**：运行目录的 `shim/` 里放 `dida.ps1` 与 `dida.cmd` 两份壳。PowerShell 同目录内优先命中 `.ps1`，其 `@args` 原样展开、多行 `--content` 保真；显式写 `dida.cmd` 时会落到 `.cmd`，那里的 `%*` 仍把多行截成第一行。agent 仍可用绝对路径直接调真 `dida.cmd` / `dida.ps1` 绕过 shim，`crossCheck` 逐调用比对会点名那几次调用「在日志里找不到对应」；`node <脚本>` 入口不在判据范围内。

## 产物

`runs/<runId>/` 下：

| 文件 | 内容 |
|---|---|
| `trace.ndjson` | 被测会话的原始轨迹 |
| `calls.ndjson` | shim 记下的调用序列，每行 `{argv, at, decision}`；被拒的另有 `reason` 与 `targets` |
| `created.ndjson` | 本 run 建成并立刻记账的任务，一行一条；清场与断言都只认这一份 |
| `state.json` | 终态快照：账本里每个 id 取回的现状，取不到的记 `null`。按测试清单枚举定位，枚举不到才回退账本的 `projectId`。断言读它。会话没正常结束时不取、不生成（前置门没过，判定链未开始）；会话正常结束时在结局断言那一刻取（早于清场），可信度检查不过时不取；列清单失败时不写这个文件（不写比写空数组诚实） |
| `manifest.json` | 运行目录绝对路径、skill 指纹与文件数、git rev 与 dirty、三层模型信息、工具面、轮数、成本、调用数、创建数、清场结果、标记 |
| `report.md` | 给人读的报告：首行是 skill 指纹 / 模型 / 运行目录路径，接着是判定结论与落败的断言，中间是本次创建的任务 id 表，末尾是摘要 |

`runs/` 已在 `.gitignore` 里。

运行目录在 `PASSED` 且未要求保留时删除；失败、`--keep-sandbox` 或 `--hold` 时保留，`manifest.sandboxRetained` 记录实际结果。保留现场（不清场）与保留运行目录是两件事：前者看判定结论与 `--hold`，后者看 `--keep-sandbox`。

## 已知边界

- **运行目录不是隔离边界**：cwd 只是相对路径的起点，agent 仍可用绝对路径读写文件系统任何位置，也可用绝对路径直接调真 `dida.cmd` 绕过 shim。shim 与白名单在 `shim/`、不在 cwd 里（#16），但那是减少暴露面不是安全边界——绝对路径仍读得到。见 #3。
- 轮数看门狗与预算护栏未实现，见 #11。
- 多行 `--content` 只经 `dida.ps1` 入口时保真；`dida.cmd` 的 `%*` 层仍会截成第一行。`--` 分隔符、空串值、5.1 的双引号也各有失真，汇总见 ADR-0013，处理见 #29。
- 越界写入防护只覆盖有目标清单的写命令；`habit *`、`focus *`、`tag *`、`project create`、`project group *` 一律拒绝，而不是校验它们的目标。
