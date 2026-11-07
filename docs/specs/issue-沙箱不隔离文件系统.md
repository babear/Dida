## 问题

评测沙箱**只隔离工作目录，不隔离文件系统**。被测 agent 的工作目录被设为沙箱，但它仍能用绝对路径读取沙箱外的任何文件。

实测确认（`claude -p` 子会话，工具面 `Skill,PowerShell,Read,Glob,Grep,Write`）：

```
Read C:/Users/Charles/.config/dida-cli/config.json
→ {"access_token":"dp_48d7...930"}          # 成功读出
```

滴答 Open API 的 access token 是账号级的，没有细粒度权限，泄漏即等于账号被完全接管。

## 已实测失效的缓解手段

| 手段 | 实测结果 |
|---|---|
| `--restricted` | 确实把 `Read`/`Glob`/`Grep`/`Write` 限制在工作目录内，**但它同时把 `PowerShell` 从工具面移除** |
| `--restricted` + `--tools` 加回 `PowerShell` | `PowerShell` 完全不受 `--restricted` 约束，token 仍被读出 |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` | 阻断自动加载，但 agent 主动 `Read` 仍能读到父目录的 `CLAUDE.md` |

结论：**只要工具面上有 `PowerShell`，就没有办法限制文件读取**——而本机唯一的命令执行工具就是 `PowerShell`，测试离不开它。

## 已考虑但尚未采用的缓解

- 把子进程的 `USERPROFILE` / `HOME` 重定向到沙箱，并在沙箱内放一份 token 副本；提高"随手用 `~`"的门槛，但绝对路径仍可读。
- 轨迹落盘前对 `dp_[0-9a-f]{32}` 形态的串做脱敏；防的是落盘后被提交，不是被读取，且脱敏时 token 已进入 agent 上下文与上游请求。
- 用 deny 规则挡敏感路径；命令写法变体多（`gc`、`type`、路径拼接），正则挡不住，可能提供虚假安全感。

## 影响范围

- 一份被读出的凭据会原样进入 `runs/<runId>/trace.ndjson`。在脱敏方案定下来之前，`runs/` 不得进入版本控制。
- 除滴答 token 外，理论上任何本机文件都可读，包括其它项目的凭据与配置。

## 需要决定

采用哪一组缓解措施，以及在文档中如何措辞"沙箱不安全"这件事，避免后续使用者误以为沙箱提供了安全边界。
