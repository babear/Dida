# harness

被测 agent 会话的启动器。每条 scenario 在临时沙箱里起一个全新的 `claude -p` 子进程，把它的原始轨迹落盘到 `runs/<runId>/`。

## 跑

```bash
node harness/run.mjs --scenario <id>
npm test
```

| 参数 | 默认 | 作用 |
|---|---|---|
| `--scenario <id>` | 全部 | 只跑 `scenarios/<id>/` 这一条 |
| `--skill-path <dir>` | `skills/dida-cli` | 要复制进沙箱的 skill 目录 |
| `--settings <file>` | `~/.claude/settings.json` | 取 `ANTHROPIC_*` 键的来源 |
| `--keep-sandbox` | 关 | 成功时也保留沙箱（失败时总是保留） |

退出码：任一会话非零退出或超时即 1。

**当前判定口径**：只看会话是否正常退出（`COMPLETED` / `INCOMPLETE`）。结局断言与过程断言分别属于 #7 与 #8，接上之后才构成 scenario 的通过或失败。

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
├── agents.json            # --agents 的定义，工具面限定
├── bin/dida.cmd           # 前置到 PATH 的透传 shim
└── materials/             # scenario 素材（若有）
```

会话以沙箱为 `cwd`、`CLAUDE_CONFIG_DIR` 指向沙箱的 `.claude/` 启动，并从父进程环境里剔除全部以 `CLAUDE` 开头的变量。实测这样只暴露 `.claude/skills/` 里那一份 skill，`~/.claude/skills/` 下的同名软链接不参与竞争。

## 调用方标记

每次运行在沙箱副本的 `SKILL.md` 末尾追加一段 `## 调用方标记`，内容为 `HARNESS-CALLER-MARKER-<runId>`，同时写进 manifest 的 `marker`。

它是"agent 读的确实是沙箱副本"的可核对凭据：在 `trace.ndjson` 里搜到该标记、而全局软链接那份里没有，就排除了"测的是主仓库旧版本"。

## 会话启动契约

- `--agents` + `--agent dida-scenario`：工具面 `Skill`、`PowerShell`、`Read`、`Glob`、`Grep`、`Write`。`--allowedTools` 必须同时给，否则 `dontAsk` 会拒掉所有命令。
- stdin 重定向到 `ignore`（即 `/dev/null`）。不关 stdin 时 `claude -p` 会等输入并挂死。
- `--output-format stream-json --verbose` 写 `trace.ndjson`，`--no-session-persistence` 避免落进用户目录。
- 环境：`sanitizeEnv` 剔除从父进程继承的全部 `CLAUDE` 开头变量，再显式设回 `CLAUDE_CONFIG_DIR`。**这不是完整的环境隔离**——CLI 会自行注入 `CLAUDECODE`、`CLAUDE_CODE_SESSION_ID` 等一批变量，与父进程传不传无关，清单与含义见 ADR-0008 的后果段。写断言时不要假设子进程环境干净。
- 超时上限 15 分钟，超时后杀子进程并标 `timedOut`，沙箱保留。只杀直接子进程，尚未杀进程树——看门狗属于 #11。

## shim

单份 `bin/dida.cmd`，内容是 `CALL "<真 dida.cmd>" %*` 后透传退出码。必须写**绝对路径**：写 `CALL dida.cmd` 会按 `PATH` 解析回自己，批处理递归 339 层后崩掉。解析不到真 CLI 时直接报错，不降级成自递归。

**与 ADR-0004 的偏离**：当前只做透传，没有记账到调用日志，也没有拒绝越界写入。这两项属于 #6，实现后 shim 规则才与 ADR-0004 完全一致。

## 产物

`runs/<runId>/` 下的 `trace.ndjson`（原始轨迹）与 `manifest.json`：沙箱绝对路径、skill 指纹与文件数、git rev 与 dirty、三层模型信息、工具面、轮数、成本、标记。`runs/` 已在 `.gitignore` 里。

成功时删除沙箱，失败或 `--keep-sandbox` 时保留，`manifest.sandboxRetained` 记录实际结果。

## 已知边界

- 沙箱只隔离工作目录，不隔离文件系统：agent 仍可用绝对路径读沙箱外的文件。见 #3。
- 轮数看门狗与预算护栏未实现，见 #11。
