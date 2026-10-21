# 任务域（dida task）

> 字段语义搬自已安装的 README，版本与校对规则见 `SKILL.md`。
>
> 参数与取值一律跑 `dida task <cmd> --help`；本文只写它给不出的。

## 能力缺口

- **无法把任务（含笔记类）归到看板列**：`task create` / `task update` 都没有 `--column` 参数，任务上的 `columnId` 只能读、不能写。列本身归清单域，见 [project.md](project.md)。
- **`task search` 的关键词是必需项**：不带关键词直接调用，API 返回 500，Node 以断言崩溃退出（`UV_HANDLE_CLOSING`，退出码 `3221226505`）。要列全量用 `project data` 或 `task filter`。
- **重复规则只能改、不能清空**：`--repeat-from` 只接受 `0`/`1`/`2`，传 `none` 会报错退出；`--repeat ""` 会写入一个空的 `repeatFlag`，不是清除。
- **`task filter` 在大清单上输出可达数百 KB**：先想清楚要哪些字段，必要时在本地过滤。

## 写入

- `task update` 要同时给位置参数 `<taskId>` 和 `--id <taskId>`，两者缺一不可。

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
| `repeatFrom` | 重复起算方式 | 仅 `repeatFlag` 非空时被读取，否则是惰性字段 |
| `completedTime` | 完成时间 | 仅已关闭任务可改，不可清除 |
| `status` | `-1` 已放弃、`0` 未完成、`2` 已完成 | |
| `items` | 检查事项 | 见下 |
| `tags` | 标签 | |
| `columnId` / `columnName` | 看板列 | **只读**；没有 CLI 参数可写 |
| `parentId` / `childIds` | 父子任务关系 | |
| `focusSummaries` | 专注汇总 | 见下 |
| `assigneeUsername` | 负责人 | 通过 `task assign` 设置 |
| `etag` | 服务端乐观锁 | 只读 |
| `kind` | 任务类型：`TEXT`、`NOTE`、`CHECKLIST` | 与清单 `kind`（`TASK`/`NOTE`）不是一回事 |

### `reminders` 语法

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

### `repeatFlag` 语法

- `RRULE:` 标准重复；`ERULE:` 自定义或高级重复。
- 一条 `repeatFlag` 只带一种前缀：`RRULE:` 或 `ERULE:`。

```
RRULE:FREQ=DAILY
RRULE:FREQ=WEEKLY;BYDAY=MO,WE
ERULE:NAME=CUSTOM;BYDATE=20260325,20260330
```

`repeatFrom` 只在 `repeatFlag` 非空时生效：`0` 按原截止日期、`1` 按完成日、`2` 按日历默认。

### `items[]` 检查事项

| 字段 | 含义 |
|---|---|
| `id` | ObjectId 十六进制 |
| `status` | `0` 未完成、`1` 已完成 |
| `title` | 文案 |
| `sortOrder` | 事项间排序 |
| `startDate` / `isAllDay` / `timeZone` / `completedTime` | 可选的时间与完成信息 |

### `focusSummaries[]`

可写（`task update`）：`estimatedDuration`（秒）、`estimatedPomo`（番茄数，最大 60）。

只读：`pomoCount`、`pomoDuration`（秒）、`stopwatchDuration`（秒）。

## 批量完成

`task complete-batch --json` 输出 `{ "completed": [...], "failed": [...] }`；有未完成项时退出码为 `1`。
