# PowerShell 下给 CLI 多值参数加引号

在 PowerShell 下，参数值里含 `,`（以及 `;` `()` `@` `{}` `$`）时，给整个值加引号；引号包住值、`=` 前后不留空格，别包住整段 `"--status=-1,0,2"`（误把 `=` 写成空格会静默变成垃圾参数）：

```powershell
dida task filter --projects <projectId> --status="-1,0,2"
```

`--%` 在这里不管用：那是给原生命令用的停止解析符号，而 `dida` 是 `.ps1` 脚本壳（实测报 `unknown option '--%'`）。

为什么：npm 在 Windows 上给每个全局包生成三个壳（`dida` / `dida.cmd` / `dida.ps1`），PowerShell 解析到 `.ps1`，而它把 `.ps1` 当 PowerShell 脚本解析——`, ` 在那里是数组操作符。
