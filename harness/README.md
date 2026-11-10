# harness

被测 agent 会话的启动器。每条 scenario 在临时沙箱里起一个全新的 `claude -p` 子进程，把它的原始轨迹落盘到 `runs/<runId>/`。

## 跑

```bash
node harness/run.mjs --scenario <id>
npm run test:harness  # harness 自己的单元测试，不烧 API
```

`npm run test:harness` 跑与被测文件同目录的 `*.test.mjs`。跑 scenario 要真实 API 会话，没有 `npm test` 别名——等 #7 加回 `s1-plan-to-task` 再恢复。

| 参数 | 默认 | 作用 |
|---|---|---|
| `--scenario <id>` | 全部 | 只跑 `scenarios/<id>/` 这一条 |
| `--skill-path <dir>` | `skills/dida-cli` | 要复制进沙箱的 skill 目录 |
| `--settings <file>` | `~/.claude/settings.json` | 取 `ANTHROPIC_*` 键的来源 |
| `--keep-sandbox` | 关 | 成功时也保留沙箱（失败时总是保留） |
| `--hold` | 关 | 跑完不清场，留现场给人看；之后用 `--clean <runId>` 收尾 |
| `--clean <runId>` | — | 只按该 run 的 `created.ndjson` 删除任务，然后退出 |

退出码：任一会话非零退出或超时即 1；清场中止或删除失败也是 1。

**当前判定口径**：只看会话是否正常退出（`COMPLETED` / `INCOMPLETE`）。结局断言与过程断言分别属于 #7 与 #8，接上之后才构成 scenario 的通过或失败。

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
| `DIDA_TEST_PROJECTS` | 测试清单 id，逗号分隔。不设时用 `Test_1` 与 `Test_2`（见 `harness/lib/projects.mjs`）。覆盖成空值会退回默认 |

## scenario

`scenarios/<id>/scenario.json` 目前只有 `prompt` 一个字段，是被测 agent 能看到的唯一输入。同目录的 `materials/`（可选）会整体复制进沙箱的 `materials/`。

断言、期望行为与反馈原文都不进 scenario 目录——被测 agent 的工作目录就是沙箱，看不到仓库。

## 沙箱

建在 `%TEMP%/run-<runId>/`，**不放在仓库内**：仓库子目录会继承父目录的 `CLAUDE.md` 与 `.claude/skills/`，后者的同名 skill 会与沙箱副本竞争。

```
run-<runId>/
├── .claude/
│   ├── settings.json      # 只含源 settings.json 的 ANTHROPIC_* 键
│   └── skills/dida-cli/   # 从 --skill-path 整体复制，末尾追加调用方标记
├── agents.json            # 从 harness/agents.json 复制，工具面限定
├── bin/dida.cmd           # 前置到 PATH 的透传 shim
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

沙箱 `bin/` 下有三个文件：

- `dida.cmd`：一行 shell 壳，`node dida-shim.mjs <node 可执行> <真 CLI 脚本> %*`。
- `dida-shim.mjs`：记账 + 转发。
- `lib/`：shim 只依赖的三个模块（`calllog.mjs`、`created.mjs`、`shim.mjs`）。

**为什么不是 `CALL "<真 dida.cmd>" %*`**：实测 `.cmd` 的 `%*` 转发在含换行的参数上会截断到第一行，`%VAR%` 也会被展开。改成从真 `.cmd` 里解析出 node 与脚本入口后直接 spawn，argv 由 `CreateProcess` 原样传递，空格、引号、中文、`|`、`&`、`%` 都保真。解析不到入口时直接报错，不降级成自递归。

**记账**：每次调用在转发**之前**追加一行到 `runs/<runId>/calls.ndjson`，内容为 `{argv, at}`，`argv` 是数组而非命令字符串。`task create` 成功后从 stdout 抠出任务 id（`ID: <24 位十六进制>` 或 `--json` 的对象），追加到 `runs/<runId>/created.ndjson`（一行一条）。

**与 ADR-0004 的偏离**：目标清单校验与越界写入拒绝属于 #6，尚未实现。记账只做事实记录，不做拦截。

**已知边界**：参数在 `dida.cmd` 这一层已经由 cmd 解析过一遍，多行 `--content` 会在这里被截成第一行。修法要绕开 `.cmd` 形态本身，另开 issue 追踪。

## 产物

`runs/<runId>/` 下：

| 文件 | 内容 |
|---|---|
| `trace.ndjson` | 被测会话的原始轨迹 |
| `calls.ndjson` | shim 记下的调用序列，每行 `{argv, at}` |
| `created.ndjson` | 本 run 建成并立刻记账的任务，一行一条；清场与断言都只认这一份 |
| `manifest.json` | 沙箱绝对路径、skill 指纹与文件数、git rev 与 dirty、三层模型信息、工具面、轮数、成本、调用数、创建数、清场结果、标记 |
| `report.md` | 给人读的报告：首行是 skill 指纹 / 模型 / 沙箱路径，中间是本次创建的任务 id 表，末尾是摘要 |

`runs/` 已在 `.gitignore` 里。

成功时删除沙箱，失败、`--keep-sandbox` 或 `--hold` 时保留，`manifest.sandboxRetained` 记录实际结果。

## 已知边界

- 沙箱只隔离工作目录，不隔离文件系统：agent 仍可用绝对路径读沙箱外的文件。见 #3。
- 轮数看门狗与预算护栏未实现，见 #11。
- 多行 `--content` 在 `dida.cmd` 的 `%*` 层会被截成第一行（见上文 shim 段）。
