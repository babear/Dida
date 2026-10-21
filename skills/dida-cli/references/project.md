# 清单域（dida project）

> 什么时候读：要查/建/改清单、看清单字段、用 `project data` 或看板列时。
> 参数以 `dida project <cmd> --help` 为准；本文写它给不出的。

## 命令一览

| 想做的事 | 命令 | 注意 |
|---|---|---|
| 列出清单 | `dida project list` | 收集箱不在其中 |
| 清单详情 | `dida project get <projectId>` | |
| 清单 + 未完成任务 + 看板列 | `dida project data <projectId>` | |
| 成员 | `dida project members <projectId>` | |
| 创建 / 更新 / 删除清单 | `dida project create` / `update` / `delete` | |
| 文件夹分组 | `dida project group list/create/update/delete` | |
| 看板列 | `dida project column list/create/update` | |

## 返回字段

`project list` / `project get --json` 的对象，以及 `project data` 里的 `project`：

| 字段 | 含义 |
|---|---|
| `id` | 清单 ID，ObjectId 十六进制 |
| `name` | 名称 |
| `color` | 颜色 |
| `sortOrder` | 侧栏顺序 |
| `closed` | 是否关闭/归档 |
| `groupId` | 文件夹 ID |
| `viewMode` | `list`、`kanban`、`timeline` |
| `permission` | `read`、`comment`、`write` |
| `kind` | `TASK` 或 `NOTE`；与任务 `kind`（`TEXT`/`NOTE`/`CHECKLIST`）不是一回事 |

## `project data`

根对象：`project`、`tasks`、`columns`。`tasks` 只含未完成。

收集箱：`project data inbox` 不返回 `project` 对象，任务的 `projectId` 是 `inbox1011141916`；`task get` / `task filter` 接受 `inbox` 和该 id 两种写法。

## 看板列

`columns[]` 的字段：

| 字段 | 含义 |
|---|---|
| `id` | 列 ID |
| `projectId` | 所属清单 |
| `name` | 列标题 |
| `sortOrder` | 看板上的顺序 |

- **分栏与视图模式正交**：`viewMode: list` 的清单同样返回 `columns`（已实测）；判断有没有列看 `columns`，`viewMode` 不参与。
- 命令只有 `column list` / `column create` / `column update`——没有删除列的命令。
- 任务无法通过 CLI 归到某列：`task create` / `task update` 没有 `--column`，任务上的 `columnId` 只读。见 [task.md](task.md)。

## 分组与成员

- 清单分组（文件夹）：`project group` 子命令。
- 成员：`project members <projectId>`，其中的 `username` 供 `task assign --assignee` 使用。
