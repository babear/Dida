# s1-plan-to-task

**这条 scenario 必须在合并前删除。**

它在当前 skill 上跑不出「红」：两次真实会话（含去掉原话里的答案泄漏后）都一次做对，
断言全过。按 `skill-tests/README.md` 的标准它是假测试，不该进回归网。

留在这里的理由只有一个：它是断言机制目前唯一的真实用例。跑一次就能验证
`state.json`、`assert.mjs` 装配与报告判定这整条链路接线正确，不用凭空相信。

复现价的问题记在 [babear/Dida#7](https://github.com/babear/Dida/issues/7)。删掉它
不代表问题解决——那条 issue 需要另找一条真能复现缺陷的 scenario。

删除时一并收掉的四处（`report.test.mjs` 里的 `s1-plan-to-task` 只是夹具名，不用动）：

- 本目录
- `package.json` 的 `test:scenarios` 脚本
- `harness/README.md` 第 12 行提到 `test:scenarios` 的那句
- `skill-tests/README.md` 第 104 行末尾提到 `test:scenarios` 的那半句
