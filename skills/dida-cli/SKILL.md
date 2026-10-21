---
name: dida-cli
description: 通过 dida-cli 操作滴答清单的任务、清单、标签、习惯与专注。当用户提到 dida、dida-cli、滴答清单，或需要查询、创建、修改待办任务、清单、习惯打卡、番茄钟时使用；执行任何 dida 命令前，先读已安装包内的用法说明。
---

# dida-cli

滴答清单（DIDA）命令行工具，封装 [DIDA Open API v1](https://developer.dida365.com/docs#/openapi)。

Install（`dida` 不存在时执行）：`npm i -g @suibiji/dida-cli`

## Start here

这是一个 discovery stub，不是用法说明。执行任何 `dida` 命令前：

1. 读**已安装版本自带**的用法说明——它随安装版本走，永不漂移。路径是全局包内的 README：

   `$(npm root -g)/@suibiji/dida-cli/README.md`

   读完应能说出：要用的子命令、其必填参数、`--json` 输出的字段结构。任一说不清，就是没读到位。

2. 确认已登录：`dida auth status`。未登录时 `dida auth login`（无浏览器环境用 `dida auth token <token>`）。
3. 命令的精确参数一律以本地为准：`dida <command> --help`——版本匹配且精确，比 README 更可信。

## 查询分流

README 列出了每条命令，但不说面对哪种意图该挑哪条。看任务这件事有四条路：

| 意图 | 命令 |
|---|---|
| 某清单**当前待办**（含分组） | `dida project data <projectId> --json`（**只返回未完成任务**，另带 `columns`） |
| 要**全部状态**（含已完成/已放弃） | `dida task filter --projects <projectId> --status=-1,0,2 --json` |
| 按**完成时间段**列已完成 | `dida task completed --projects <projectId> --start-date … --end-date …` |
| 按**关键词/标签**找 | `dida task search [keywords]` |

含逗号的参数值在 PowerShell 下要加引号：`--status="-1,0,2"`。详见 [references/powershell-arg-quoting.md](references/powershell-arg-quoting.md)。

清单 ID 先取：`dida project list --json`。

**收集箱是例外**：它不出现在 `project list` 里，projectId 直接用字面量 `inbox`：

```
dida project data inbox --json
dida task filter --projects inbox --status=-1,0,2 --json
```

## 补充参考

- [references/package-lookup.md](references/package-lookup.md) — 取不到 `npm root -g` 的输出时读它。
