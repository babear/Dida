# ADR-0008：每次运行把 skill 复制进沙箱并记录内容指纹

- 状态：接受
- 日期：2026-11-06

## 背景

`~/.claude/skills/dida-cli` 是一个软链接，指向主仓库的 `skills/dida-cli`，**不是**当前 worktree。在 worktree 里改 skill，全局那份纹丝不动——任何"顺手用全局 skill"的测法，测的永远是主仓库的旧版本，测试会一直绿或一直红，而原因与改动无关。

同时本机认证不在 OAuth 凭据文件里，而在 `~/.claude/settings.json` 的 `env` 段（`ANTHROPIC_AUTH_TOKEN=PROXY_MANAGED` + `ANTHROPIC_BASE_URL` 指向本地代理）。把 `CLAUDE_CONFIG_DIR` 指向空目录会同时丢掉用户级 skill（这正是想要的）和这份认证（不想要的）。同一份配置还把 opus / sonnet / fable / haiku 全部重映射到中转站的 `deepseek-v4.1-flash` 系列，因此 CLI 自报的模型名是别名，不是实际执行的模型。

## 决定

每条 scenario 运行时创建一个临时沙箱，**把 `--skill-path` 指定的目录整体复制**进沙箱的 `.claude/skills/dida-cli/`，复制后对目录算 SHA-256，连同 git rev 与 dirty 状态写进 `runs/<runId>/manifest.json`。

沙箱的 `settings.json` 只写入源 `settings.json` 中所有 `ANTHROPIC_*` 键，其余（模型选择器、语言、更新器开关）一律不带。会话以 `CLAUDE_CONFIG_DIR` 指向沙箱配置目录启动，并清掉从父进程继承的全部以 `CLAUDE` 开头的环境变量（含无下划线的 `CLAUDECODE`）。

模型记录三层并标注可信度：`requested_alias`（CLI 自报，实为别名）、`resolved_model`（从 `ANTHROPIC_DEFAULT_*` 读到的真实映射）、`provider`（代理地址）。

## 考虑过的方案

- **沙箱内软链接到源路径**：Windows 建软链接需管理员权限；且 agent 若有写权限会直接改到工作副本。
- **整份复制 `settings.json`**：省事，但把个人偏好混进被测环境，结果难以归因。
- **依赖全局软链接**：正是本节开头描述的事故。

## 后果

- 每次运行多一次目录复制，成本可忽略。
- 任一历史报告都能反推出当时测的是哪一份 skill，即使源码已经改动。
- 改了默认模型后历史结果不可比，manifest 里的 `resolved_model` 是唯一可查的凭据。
- **清理只覆盖继承的部分，不保证子进程环境干净。** 实测 `claude -p` 会自行注入 `CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_SESSION_ATTENDED`、`CLAUDE_PID`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_AGENT`、`CLAUDE_CODE_MESSAGING_*` 等变量，父进程传不传都一样。这是 CLI 内部构造子会话环境的硬编码行为，harness 无法消除。因此"沙箱环境干净"不能作为断言的前提。
- `CLAUDECODE` 在 CLI 里只参与嵌套会话判定（跳过 prompt 历史、关闭 BYOC 资源看门狗）与遥测上下文，不改变工具面或行为策略。实测保留与剔除两种情形下 `system:init` 的工具面、slash_commands、模型、cwd 与最终结果完全一致，所以把它纳入剔除清单是判据与文档口径的统一，没有行为收益。
