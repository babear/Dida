---
name: dida-cli
description: dida-cli（滴答清单）：查询、创建、修改待办任务、清单、标签、习惯打卡与专注记录。用户提到 dida 或滴答清单时使用。
---

# dida-cli

滴答清单（DIDA）命令行工具，封装 [DIDA Open API v1](https://developer.dida365.com/docs#/openapi)。

## 前置检查（每个会话首次操作前）

1. `dida` 不存在 → `npm i -g @suibiji/dida-cli`
2. `dida auth status`；未登录 → `dida auth login`（无浏览器环境用 `dida auth token <token>`）
3. `dida --version` 应为 `0.1.14`——这是域文档标注的版本。不一致时，本会话的字段语义以已安装 README 的「JSON 字段与命令对应关系」为准（`$(npm root -g)/@suibiji/dida-cli/README.md`），并告知用户 skill 需要更新。

## 怎么做事

1. **找命令**：不知道用哪条 → `dida --help` 看组，`dida <group> --help` 看子命令与参数。参数以 `--help` 的输出为准。
2. **查细节**：`--help` 不写的取舍、字段、语法与坑，在对应域文档：
   - [task.md](references/task.md)：任务命令一览、查询取舍、返回字段、`reminders`/`repeatFlag`
   - [project.md](references/project.md)：清单命令一览、返回字段、`project data`、看板列
   - 其余域（习惯、专注、标签、倒数日、偏好）直接 `--help`
3. **写操作走「读 → 改 → 验」**：`task get` 取现状 → `task update` 写 → `task get` 复核；复核输出与预期一致才算完成，向用户汇报也用它的结果。示例见 [task.md](references/task.md)。

## 硬规则

- 默认只给未完成内容。用户明确要已完成、已放弃，或指定时间段时才扩大范围。
- 含逗号的参数值在 PowerShell 下加引号：`--status="-1,0,2"`，见 [references/powershell-arg-quoting.md](references/powershell-arg-quoting.md)。
