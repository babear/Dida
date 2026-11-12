# ADR-0009：shim 记账用 node 脚本，转发直接调 CLI 入口而非再走一次 `.cmd`

- 状态：接受
- 日期：2026-11-07

## 背景

ADR-0004 定下的 shim 是一份 `bin/dida.cmd`，内容为 `CALL "<真 dida.cmd>" %*`。实现 #5 的调用日志与 `created.json` 时需要两件事：

1. 记下**解析后的 argv 数组**，而不是命令字符串——过程断言要靠它，重新解析引号会引入第二套语法。
2. 转发后从 stdout 抠出 `task create` 的任务 id，落进 `created.json`。

第 1 条要求记账发生在 cmd 解析之后、真 CLI 之前。这必须在 `.cmd` 之外再放一层程序。

## 实测的三条事实

| 形态 | 多行 `--content` | `%VAR%` | `\|` `&` |
|---|---|---|---|
| `.cmd` 里 `CALL ... %*` | **截成第一行** | **被展开** | `\|` 导致转发失败 |
| node 拼命令行 + `cmd /d /s /c` | 截成第一行 | 被展开 | 保真 |
| node 直接 `spawn(program, [script, ...argv])` | **保真** | **保真** | **保真** |

对照组用的是同一个 printer 脚本：`.cmd` 转发后 node 收到 `["--content","line1"]`，直接 spawn 后收到 `["--content","line1\r\nline2"]`。真 CLI 实测落盘的 `content` 同样是 `"第一行"`——不是 printer 的假象。

结论：**`.cmd` 的 `%*` 这一层本身就不保真**。只要转发还要经过它，多行正文就会丢。

## 决定

shim 拆成两部分：

- `bin/dida.cmd`：一行壳，`node dida-shim.mjs <node 可执行> <真 CLI 脚本> %*`。
- `bin/dida-shim.mjs`：记账、spawn、抓 id、透传退出码。

`.cmd` 只是入口形态（保持 ADR-0004 的"单份 `.cmd`"），实际转发**绕开 cmd**：从真 `.cmd` 里用正则抠出 node 与脚本路径（`SET _prog=` 与 `"...\index.js" %*`），直接 `spawnSync(program, [script, ...argv])`，argv 由 `CreateProcess` 原样传递。

解析不出入口时直接报错，不退回 `CALL` 转发——那会静默降级成丢多行参数的行为。

## 后果

- `.cmd` 那一层仍会解析一遍 argv：`%VAR%` 在到达 `dida-shim.mjs` 之前已经被展开，**多行 `--content` 仍会在 `.cmd` 处截断**。`.ps1` 入口补上了这一点，见 ADR-0013；显式走 `.cmd` 时仍成立。
- 绕开 cmd 后，真 CLI 的退出码是 node 的退出码而非 cmd 的；实测一致（都是 CLI 进程本身的退出码）。
- 若真 CLI 换了一种生成 `.cmd` 的方式（不是 npm 的模板），解析会失败并报错，需要更新正则。测试 `test/shimparse.test.mjs` 覆盖了这条。
- Node 24 起 `spawnSync` 不允许直接执行 `.cmd`（`EINVAL`），所以清场路径也复用同样的"解析入口 + 直接 spawn"，见 `run.mjs` 的 `realDida()`。
