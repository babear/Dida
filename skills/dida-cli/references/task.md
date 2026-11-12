# 任务域（dida task）

> 什么时候读：要查任务、写任务、看任务返回字段、用 `reminders` 或 `repeatFlag` 时。
> 参数以 `dida task <cmd> --help` 为准；本文写它给不出的。

## 命令一览

| 想做的事 | 命令 | 注意 |
|---|---|---|
| 已知 ID，取一条 | `dida task get <projectId> <taskId>` | |
| 列当前清单任务，要带看板列分组或只要未完成 | `dida project data <projectId>`（清单域） | 只返回未完成；见 [project.md](project.md) |
| 列全量、全状态，或按 dueDate 筛 | `dida task filter --projects <id>` | 唯一能一次拿全状态；大清单输出可达数百 KB |
| 按**完成时间**区间列已完成 | `dida task completed --projects <id> --start-date … --end-date …` | 区间按 `completedTime`；`filter` 的区间按 `dueDate`——两者不可互换（已实测） |
| 按关键词找 | `dida task search <keywords>` | 关键词必填；空值会导致 API 500 与进程崩溃 |
| 创建 | `dida task create` | |
| 更新 | `dida task update <taskId> --id <taskId>` | 位置参数和 `--id` 都要给 |
| 完成 | `dida task complete <projectId> <taskId>` | |
| 批量完成 | `dida task complete-batch` | 同一清单最多 50 条；`--json` 输出 `{completed, failed}`，有失败时退出码 1 |
| 删除 | `dida task delete <projectId> <taskId>` | |
| 清单间移动 | `dida task move` | |
| 分配 / 取消 | `dida task assign` / `dida task unassign` | `username` 取自 `project members` |
| 评论 | `dida task comment list/add/delete` | |

任务无法通过 CLI 归到看板列：`create` / `update` 没有 `--column`，任务上的 `columnId` 只读。列本身见 [project.md](project.md)。

收集箱：projectId 用字面量 `inbox`。`project data inbox` 不返回 `project` 对象，任务的 `projectId` 是 `inbox1011141916`；`task get` 与 `task filter` 两种写法都接受。

## 读改验

改任务前先取现状，改完再取一次复核；向用户汇报用复核结果。

```powershell
# 1. 找：收集箱里标题为「研究 matt github 项目」的任务
$data = dida project data inbox --json | ConvertFrom-Json
$task = $data.tasks | Where-Object { $_.title.Trim() -eq '研究 matt github 项目' }

# 2. 读：取当前正文
dida task get inbox $task.id --json

# 3. 改：多行正文用 here-string
$body = @'
清洗后的第一行
清洗后的第二行
'@
dida task update $task.id --id $task.id --project inbox --content $body

# 4. 验：以这一步的输出为准
dida task get inbox $task.id --json
```

PowerShell 若因执行策略拒绝未签名的 `dida.ps1`，把命令里的 `dida` 换成 `dida.cmd`。

已完成的任务不在 `project data` 里；按标题找已完成的任务用 `dida task filter --status=2`。

## 返回字段

`task get --json`、带 `--json` 的 `task create` / `task update`、`task filter` / `task completed` 的每一行，以及 `project data` 里的 `tasks[]`，都是这个结构。

| 字段 | 含义 | 备注 |
|---|---|---|
| `id` | 任务 ID | ObjectId 十六进制 |
| `projectId` | 所属清单 | |
| `sortOrder` | 列表排序 | |
| `title` | 标题 | 长文放 `content` |
| `content` | 普通/笔记类任务的正文 | |
| `desc` | 清单类任务的说明 | |
| `startDate` / `dueDate` | 时间；两者不同表示一段区间 | |
| `timeZone` | 时区 | |
| `isAllDay` | 是否全天 | |
| `priority` | `0` 无、`1` 低、`3` 中、`5` 高 | |
| `reminders` | 提醒触发字符串数组 | 语法见下 |
| `repeatFlag` | 重复规则 | 语法见下 |
| `repeatFrom` | 重复起算方式 | 仅 `repeatFlag` 非空时被读取 |
| `completedTime` | 完成时间 | 仅已关闭任务可改，不可清除 |
| `status` | `-1` 已放弃、`0` 未完成、`2` 已完成 | |
| `items` | 检查事项 | 见下 |
| `tags` | 标签 | |
| `columnId` / `columnName` | 看板列 | 只读；没有 CLI 参数可写 |
| `parentId` / `childIds` | 父子任务关系 | |
| `focusSummaries` | 专注汇总 | 见下 |
| `assigneeUsername` | 负责人 | 通过 `task assign` 设置 |
| `etag` | 服务端乐观锁 | 只读 |
| `kind` | 任务类型：`TEXT`、`NOTE`、`CHECKLIST` | 与清单 `kind`（`TASK`/`NOTE`）不是一回事 |

## `reminders` 语法

每项形如：

`TRIGGER(;RELATED=START|END)?:(-)?P[nY][nM][nW][nD][T[nH][nM][nS]]`

- `TRIGGER` 必填。
- `;RELATED=START|END` 可选，相对开始或结束时间。
- 冒号后的 `-` 可选，表示在参考时间**之前**触发；不写表示之后。
- `P` 后是时长：`nY`/`nM`/`nW`/`nD` 为年月周日，`T` 分隔日期与时间，`nH`/`nM`/`nS` 为时分秒。

| 字符串 | 含义 |
|---|---|
| `TRIGGER:-PT60M` | 参考时间前 60 分钟 |
| `TRIGGER:-P1DT2H` | 参考时间前 1 天 2 小时 |
| `TRIGGER;RELATED=END:-PT15M` | **结束时间**前 15 分钟 |
| `TRIGGER:PT0S` | 准时 |

## `repeatFlag` 与 `repeatFrom`

- `RRULE:` 标准重复；`ERULE:` 自定义或高级重复。
- 一条 `repeatFlag` 只带一种前缀：`RRULE:` 或 `ERULE:`。

```
RRULE:FREQ=DAILY
RRULE:FREQ=WEEKLY;BYDAY=MO,WE
ERULE:NAME=CUSTOM;BYDATE=20260325,20260330
```

`repeatFrom` 只在 `repeatFlag` 非空时生效：`0` 按原截止日期、`1` 按完成日、`2` 按日历默认。

`--repeat-from` 只接受 `0`/`1`/`2`，传 `none` 会报错；`--repeat ""` 写入一个空的 `repeatFlag`，不是清除。

## `items[]` 检查事项

| 字段 | 含义 |
|---|---|
| `id` | ObjectId 十六进制 |
| `status` | `0` 未完成、`1` 已完成 |
| `title` | 文案 |
| `sortOrder` | 事项间排序 |
| `startDate` / `isAllDay` / `timeZone` / `completedTime` | 可选的时间与完成信息 |

`--items` 是整段 JSON 走一个命令行参数。Windows 下 `CreateProcess` 对**整条命令行**限 32767 字符（不是单个参数），按每条约 48 字符算，约 680 条就会到顶、1000 条必失败（`ENAMETOOLONG`）。超过这个量就分批写。

## `focusSummaries[]`

可写（`task update`）：`estimatedDuration`（秒）、`estimatedPomo`（番茄数，最大 60）。

只读：`pomoCount`、`pomoDuration`（秒）、`stopwatchDuration`（秒）。
