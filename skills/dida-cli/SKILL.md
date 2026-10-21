---
name: dida-cli
description: dida-cli（滴答清单）：查询、创建、修改待办任务、清单、标签、习惯打卡与专注记录。用户提到 dida 或滴答清单时使用。
---

# dida-cli

滴答清单（DIDA）命令行工具，封装 [DIDA Open API v1](https://developer.dida365.com/docs#/openapi)。

## 前置检查（每个会话首次操作前）

1. `dida` 不存在 → `npm i -g @suibiji/dida-cli`
2. `dida auth status`；未登录 → `dida auth login`（无浏览器环境用 `dida auth token <token>`）
3. `dida --version` 应为 `0.1.14`——这是域文档标注的版本。不一致时告知用户 skill 需要更新。

## 真相源

按顺序取——前面的够用就不翻后面的：

1. `dida <command> --help`——参数与取值的唯一真相，随安装版本走。**执行任何命令前先跑它**，参数以它的输出为准。
2. 本 skill 的域文档——`--help` 不写的跨命令知识：
   - [references/task.md](references/task.md)：任务写操作、返回字段、`reminders`/`repeatFlag` 语法、能力缺口
   - [references/project.md](references/project.md)：清单字段、`project data` 的返回范围、看板列与视图模式
   - 其余域（习惯、专注、标签、倒数日、偏好）直接跑 `--help`，已完整覆盖。
3. 已安装的 README——字段语义的原始出处。版本一致时以域文档为准；不一致时（前置检查第 3 步）以它为准，覆盖域文档的字段部分。
   - 位置：`$(npm root -g)/@suibiji/dida-cli/README.md`，读「JSON 字段与命令对应关系」一节。

## 硬规则

- **任务写操作后必须复核**：`dida task get <projectId> <taskId> --json`，确认字段真的落库，再向用户汇报。写命令的返回不等于最终状态。
- 默认只给未完成内容。用户明确要已完成、已放弃，或指定时间段时才扩大范围。
- 含逗号的参数值在 PowerShell 下加引号：`--status="-1,0,2"`，见 [references/powershell-arg-quoting.md](references/powershell-arg-quoting.md)。

## 选哪个查询命令

`--help` 只告诉你每条命令能收什么参数，不告诉你它们的边界。看任务有四种走法：

| 意图 | 命令 | 边界 |
|---|---|---|
| 当前待办，且要保留看板列分组 | `dida project data <projectId> --json` | **只返回未完成**；唯一自带 `columns` 的列表接口 |
| 全量列表（不带关键词），或按 dueDate 筛 | `dida task filter --projects <id> --status=-1,0,2 --json` | 唯一能一次拿全状态（`-1` 已放弃、`0` 未完成、`2` 已完成）；大清单输出可达数百 KB |
| 按**完成时间**区间列已完成 | `dida task completed --projects <id> --start-date … --end-date …` | 区间按 `completedTime` 过滤；`task filter` 的区间按 `dueDate`——两者不可互换（已实测） |
| 按关键词找 | `dida task search <keywords>` | 关键词必填；空关键词会崩（详见 task.md） |

清单 ID 先取：`dida project list --json`。

**收集箱是例外**：它不出现在 `project list` 里，projectId 直接用字面量 `inbox`。
