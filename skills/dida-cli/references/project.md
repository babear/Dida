# 清单域（dida project）

> 字段语义搬自已安装的 README，版本与校对规则见 `SKILL.md`。
>
> 参数与取值一律跑 `dida project <cmd> --help`；本文只写它给不出的。

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

## 拉取清单内容

`project data <projectId> --json` 的根对象：

| 字段 | 含义 |
|---|---|
| `project` | 清单对象 |
| `tasks` | **只含未完成任务** |
| `columns` | 看板列 |

要已完成或已放弃，用 [task.md](task.md) 里的 `task filter --status=-1,0,2`。

## 看板列

`columns[]` 的字段：

| 字段 | 含义 |
|---|---|
| `id` | 列 ID |
| `projectId` | 所属清单 |
| `name` | 列标题 |
| `sortOrder` | 看板上的顺序 |

- **分栏与视图模式正交**：`viewMode: list` 的清单同样返回 `columns`（已实测）；判断有没有列看 `columns`，`viewMode` 不参与。
- 命令只有 `column list` / `column create` / `column update`——**没有删除列的命令**。
- **任务无法通过 CLI 归到某列**：`task create` / `task update` 没有 `--column`，任务上的 `columnId` 只读。详见 [task.md](task.md)。

## 其他

- 清单分组（文件夹）：`project group` 子命令。
- 清单成员：`project members <projectId>`，其中的 `username` 供 `task assign --assignee` 使用。
