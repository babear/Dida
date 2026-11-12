# harness

被测 agent 会话的启动器。每条 scenario 在临时沙箱里起一个全新的 `claude -p` 子进程，把它的原始轨迹落盘到 `runs/<runId>/`。

## 跑

```bash
node harness/run.mjs --scenario <id>
npm run test:harness  # harness 自己的单元测试，不烧 API
```

`npm run test:harness` 跑与被测文件同目录的 `*.test.mjs`。`npm run test:scenarios` 跑 `skill-tests/` 下的用例自检（断言的构造数据测试，不烧 API）。跑 scenario 本身要真实 API 会话，别名归 #9。

| 参数 | 默认 | 作用 |
|---|---|---|
| `--scenario <id>` | 全部 | 只跑 `skill-tests/scenarios/<id>/` 这一条 |
| `--skill-path <dir>` | `skills/dida-cli` | 要复制进沙箱的 skill 目录 |
| `--settings <file>` | `~/.claude/settings.json` | 取 `ANTHROPIC_*` 键的来源 |
| `--keep-sandbox` | 关 | 成功时也保留沙箱（失败时总是保留） |
| `--hold` | 关 | 跑完不清场，留现场给人看；之后用 `--clean <runId>` 收尾 |
| `--clean <runId>` | — | 只按该 run 的 `created.ndjson` 删除任务，然后退出 |

退出码：任一 scenario 断言未通过、会话非零退出或超时、用例配置错误（缺 `assert.mjs`，或断言模块加载失败、没给出合法结果）、终态快照取不到、清场中止或删除失败，都是 1。

### 清场纪律

**一条 scenario 的全部事实源是 `created.ndjson`。** 断言读它，清场删它。清单里的其它任务不在这个视野里——不检测、不报告、不碰（见 ADR-0010）。

1. **只删账本里记录的 id**。shim 每建成一条任务就追加一行（NDJSON，并发安全），清场只按这份账本删。
2. **删除目标取实际枚举到的清单**，不用账本里记的 `projectId`；两者不一致时报 `mismatched`，仍按实况删。
3. **清场失败不中断后续 scenario**。账本按 runId 隔离，删不掉自己的那几条不影响下一条。失败记 log，退出码非零。
4. **清场后自查**：删完重读清单，账本里的 id 仍在就报 `remaining`。

失败现场默认保留：沙箱、`runs/<runId>/` 与**本 run 建的任务**都不动。确认完用 `--clean <runId>` 收尾。会话正常结束后才自动清场；`--hold` 让正常结束的运行也保留。

### 环境变量

两个逃生口，在自动探测失败时使用：

| 变量 | 作用 |
|---|---|
| `CLAUDE_EXE` | `claude` 可执行文件路径。不设时依次尝试 `<node 目录>/node_modules/@anthropic-ai/claude-code/bin/claude.exe`、`<node 目录>/../node_global/…`、`npm prefix -g` 下的同一路径；全都找不到则报错退出 |
| `DIDA_CMD` | 真 `dida.cmd` 的绝对路径。不设时从 `PATH` 里找第一个 `dida.cmd`；找不到则报错退出（不会退化成自递归 shim） |
| `DIDA_TEST_PROJECTS` | 测试清单 id，逗号分隔。不设时用 `Test_1` 与 `Test_2`（见 `harness/lib/projects.mjs`）。覆盖成空值会退回默认。`run.mjs` 把它烘焙进沙箱的 `bin/lib/guard-config.mjs` 而不注入子进程环境；shim 也不读这个变量（操作者环境里若设了它，`sanitizeEnv` 会照常透传，但判定不受影响） |

## scenario

`skill-tests/scenarios/<id>/` 一个目录就是一条 scenario：

| 文件 | 作用 | 被测 agent 看得到 | 实现 |
|---|---|---|---|
| `scenario.json` | `prompt`，唯一给 agent 的文本输入 | 是 | 已有 |
| `materials/` | 可选，整体复制进沙箱 `materials/` | 是 | 已有 |
| `preset.mjs` | 可选，声明要建的任务，会话前由 harness 用真 CLI 执行 | 否 | 未实现 |
| `assert.mjs` | 结局断言，默认导出 `{tasks, created, calls, session} => 结果数组` | 否 | 已有 |

加一条 scenario 就是加一个目录，harness 一行不用改（前提是 `assert.mjs` 与 `preset.mjs` 已实现）。目录形态与三面判定的完整理由见 ADR-0012。

**`scenario.json`、`materials/` 与 `assert.mjs` 现在能跑。** `preset.mjs` 归 #19，探针归 #20。在那之前，目录里放 `preset.mjs` 不会被执行。

`preset.mjs` 建前置数据时从 harness 拿到**本次 run 的清单**，不是仓库里的默认常量——用默认常量会在环境变量覆盖时建到清场的视野外，成为删不掉的孤儿。校验规则见 ADR-0012：目标清单必须 ∈ 本次清单集合；指向已有任务的参数（`--parent-id`、`task update --id` 等）与 `--help` 这类空操作一律拒绝。它建出的任务立刻记进本 run 的账本，和 shim 记的是同一份。

`assert.mjs` 返回 `{ok, name, expected, actual}[]`，空数组即通过。它按**字段**定位任务（`childIds.length === 5`、`kind === 'TEXT'`），不按顺序猜。`created` 条目带 `origin: 'preset' | 'agent'`。

**`scenarios/<id>/` 缺 `assert.mjs` 时报错退出，不跑会话。** 跳过会让漏写或误删断言的用例静默退出回归网、退出码仍是 0。报告里单列「用例配置错误」，与「断言未通过」区分——一个去补用例，一个去改 skill。没写完的用例放 `probes/`。

没有 `assert.mjs` 的目录放在 `skill-tests/probes/<id>/` 下，是探针：跑一次拿事实样本，写断言，然后删掉。探针不参与全量判定。

`listScenarios` 只扫 `skill-tests/scenarios/`，仓库根的旧 `scenarios/` 已不再读取。

## 判定

三面按顺序短路，任一面红即非零，报告写明是哪一面：

1. **可信度检查**：调用日志条数少于轨迹里的命令调用数，说明有调用绕过 shim。失败标 `invalid` 而非 `fail`——退出码同样非零，但语义是"重跑"。见 ADR-0012。
2. **过程断言**：调用日志 argv 序列上的三条硬规则，见 ADR-0005。第 3 条（越界写入）现由 shim 当场拒绝并记 `rejected`，只需接进判定。
3. **结局断言**：读终态快照 `runs/<runId>/state.json`——账本里每个 id 取回的任务现状，取不到的记 `null`。定位与清场同一套：先按测试清单枚举再按 id 找，因为 agent 可能用 `task move` 挪走任务；枚举不到才回退到账本记的 `projectId` 直查。

**当前判定口径**：会话正常结束（`PASSED` / `FAILED` / `INCOMPLETE`）+ 结局断言。除 `PASSED` 外退出码都是 1。

| 结果 | 含义 | 怎么修 |
|---|---|---|
| `FAILED` | 断言未通过，skill 没做到 | 改 skill |
| `BROKEN` | 断言模块没给出合法结果（抛异常、返回非数组、元素缺布尔 `ok`、稀疏数组），用例有缺陷 | 改用例 |
| `INVALID` | 终态快照取不到，结果不可归因 | 重跑 |
| `MISCONFIGURED` | 缺 `assert.mjs`，不开会话但仍落一份只含判定的报告 | 补用例，或移到 `probes/` |
| `NOT FOUND` | `--scenario` 写错 id | 改正 id |

可信度检查与过程断言分别归 #8 与 #18。

## 沙箱

建在 `%TEMP%/run-<runId>/`，**不放在仓库内**：仓库子目录会继承父目录的 `CLAUDE.md` 与 `.claude/skills/`，后者的同名 skill 会与沙箱副本竞争。

```
run-<runId>/
├── .claude/
│   ├── settings.json      # 只含源 settings.json 的 ANTHROPIC_* 键
│   └── skills/dida-cli/   # 从 --skill-path 整体复制，末尾追加调用方标记
├── agents.json            # 从 harness/agents.json 复制，工具面限定
├── bin/                   # 前置到 PATH 的 shim：dida.cmd + dida-shim.mjs + lib/
└── materials/             # scenario 素材（若有）
```

`harness/agents.json` 是 `--agents` 的定义文件，在仓库里，有 diff、能 review、能回滚（选 `--agents` 的理由见 `docs/specs/dida-cli-skill-评测平台.md` 的「会话启动契约」）。运行时原样复制进沙箱，不在代码里拼装。

会话以沙箱为 `cwd`、`CLAUDE_CONFIG_DIR` 指向沙箱的 `.claude/` 启动，并从父进程环境里剔除全部以 `CLAUDE` 开头的变量。实测这样只暴露 `.claude/skills/` 里那一份 skill，`~/.claude/skills/` 下的同名软链接不参与竞争。

## 调用方标记

每次运行在沙箱副本的 `SKILL.md` 末尾追加一段 `## 调用方标记`，内容为 `HARNESS-CALLER-MARKER-<runId>`，同时写进 manifest 的 `callerMarker`。

它是"agent 读的确实是沙箱副本"的可核对凭据：在 `trace.ndjson` 里搜到该标记、而全局软链接那份里没有，就排除了"测的是主仓库旧版本"。

## 会话启动契约

- `--agents` + `--agent dida-scenario`：工具面 `Skill`、`PowerShell`、`Read`、`Glob`、`Grep`、`Write`。`--allowedTools` 必须同时给，否则 `dontAsk` 会拒掉所有命令。
- stdin 重定向到 `ignore`（即 `/dev/null`）。不关 stdin 时 `claude -p` 会等输入并挂死。
- `--output-format stream-json --verbose` 写 `trace.ndjson`，`--no-session-persistence` 避免落进用户目录。
- 环境：`sanitizeEnv` 剔除从父进程继承的全部 `CLAUDE` 开头变量，再显式设回 `CLAUDE_CONFIG_DIR`。**这不是完整的环境隔离**——CLI 会自行注入 `CLAUDECODE`、`CLAUDE_CODE_SESSION_ID` 等一批变量，与父进程传不传无关，清单与含义见 ADR-0008 的后果段。写断言时不要假设子进程环境干净。
- 超时上限 15 分钟，超时后杀子进程并标 `timedOut`，沙箱保留。只杀直接子进程，尚未杀进程树——看门狗属于 #11。

## shim

沙箱 `bin/` 下有三类文件：

- `dida.cmd`：一行 shell 壳，`node dida-shim.mjs <node 可执行> <真 CLI 脚本> %*`。
- `dida-shim.mjs`：判定 + 记账 + 转发。
- `lib/`：shim 只依赖的三个模块（`calllog.mjs`、`created.mjs`、`guard.mjs`），外加沙箱生成时烘焙的 `guard-config.mjs`（测试清单集合）。

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
- 测试清单集合在生成沙箱时烘焙进 `bin/lib/guard-config.mjs`，**不从环境变量读**：被测 agent 能读能改进程环境，从 env 读白名单等于把判定权交给它。
- **这个防护不是只读的**：`bin/` 在沙箱内，agent 的工具面里有 `Write`，可以覆写 `guard-config.mjs` 后让 shim 放行。要真正堵住需要把白名单放到 agent 写不到的位置，与「沙箱不隔离文件系统」同源，见 #3。
- 只给到命令组（`dida task`、`dida project group`）或接在组名后的 `help`（`task help`、`project group help`）只打印用法，照常放行。
- 转发时把真 CLI 错误路径上那行 `Assertion failed: … UV_HANDLE_CLOSING` 滤掉。
- 参数解析复刻 commander 语义：`--flag=value`、flag 夹在位置参数中间、`--` 之后一律当位置参数、重复 flag 全部校验、`--project=` 空值视为解析不出目标。
- 写命令缺 `--project` 时错误文本与真 CLI 不同（真 CLI 报 required option），两条路都写不出去。

**已知边界**：沙箱 `bin/` 里放 `dida.ps1` 与 `dida.cmd` 两份壳。PowerShell 同目录内优先命中 `.ps1`，其 `@args` 原样展开、多行 `--content` 保真；执行策略拒绝脚本、或调用方显式写 `dida.cmd` 时会落到 `.cmd`，那里的 `%*` 仍把多行截成第一行。agent 仍可用绝对路径直接调真 `dida.cmd` 绕过 shim，靠 `crossCheck` 在报告里标出来。

## 产物

`runs/<runId>/` 下：

| 文件 | 内容 |
|---|---|
| `trace.ndjson` | 被测会话的原始轨迹 |
| `calls.ndjson` | shim 记下的调用序列，每行 `{argv, at, decision}`；被拒的另有 `reason` 与 `targets` |
| `created.ndjson` | 本 run 建成并立刻记账的任务，一行一条；清场与断言都只认这一份 |
| `state.json` | 终态快照：账本里每个 id 取回的现状，取不到的记 `null`。按测试清单枚举定位，枚举不到才回退账本的 `projectId`。断言读它。列清单失败时不写这个文件（不写比写空数组诚实） |
| `manifest.json` | 沙箱绝对路径、skill 指纹与文件数、git rev 与 dirty、三层模型信息、工具面、轮数、成本、调用数、创建数、清场结果、标记 |
| `report.md` | 给人读的报告：首行是 skill 指纹 / 模型 / 沙箱路径，接着是判定结论与落败的断言，中间是本次创建的任务 id 表，末尾是摘要 |

`runs/` 已在 `.gitignore` 里。

成功时删除沙箱，失败、`--keep-sandbox` 或 `--hold` 时保留，`manifest.sandboxRetained` 记录实际结果。

## 已知边界

- 沙箱只隔离工作目录，不隔离文件系统：agent 仍可用绝对路径读沙箱外的文件，也可用绝对路径直接调真 `dida.cmd` 绕过 shim；`bin/lib/guard-config.mjs` 也在它的可写范围内。见 #3。
- 轮数看门狗与预算护栏未实现，见 #11。
- 多行 `--content` 只经 `dida.ps1` 入口时保真；`dida.cmd` 的 `%*` 层仍会截成第一行（#13）。
- 越界写入防护只覆盖有目标清单的写命令；`habit *`、`focus *`、`tag *`、`project create`、`project group *` 一律拒绝，而不是校验它们的目标。
