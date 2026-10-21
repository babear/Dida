# 定位包内的 README

用法说明在已安装的包里，随版本走。取它的路径，再拼 `/@suibiji/dida-cli/README.md`：

```bash
npm root -g
```

包内一切路径（README、`dist/`）都由它的输出拼接：取一次，全程用它。取不到时，沿 `dida` 的真实可执行位置（符号链接或包装脚本）追到包目录再拼。
