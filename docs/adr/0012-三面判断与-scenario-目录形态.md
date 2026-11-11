# ADR-0012：判定分三面，scenario 是数据目录，预设与探针有各自的去处

- 状态：接受
- 日期：2026-11-11

## 背景

一条 scenario 由原话、素材、可选的预设、断言四部分组成（GLOSSARY），但仓库里没有一处说清这四部分落在哪些文件里、断言读什么、跑之前怎么造前置数据。`harness/README.md` 甚至写着"断言不进 scenario 目录"，理由是"被测 agent 的工作目录就是沙箱，看不到仓库"——这个前提对，推出的结论错：仓库对 agent 不可见，恰恰说明 `scenarios/<id>/` 里放什么都安全。

同时，判定只有"会话是否正常退出"一个口径。绕过 shim 的调用只打在报告正文，不影响退出码。

## 决定

### 判定分三面，按顺序短路

| 顺序 | 面 | 读什么 | 失败含义 | 归谁 |
|---|---|---|---|---|
| 1 | 可信度检查 | 调用日志条数 vs 轨迹里的命令调用数 | 本次结果不可归因，**标为无效** | harness，全局 |
| 2 | 过程断言 | 调用日志的 argv 序列 | 做到了，但绕了远路 | harness，全局三条 |
| 3 | 结局断言 | 终态快照 | 没做到 | 每条 scenario 自己 |

任一面红即停,退出码非零。**可信度失败标 `invalid` 而不是 `fail`**——退出码一样是 1,但语义是"重跑"而非"skill 有缺陷"。区分它们是为了让红绿循环不被偶发的绕过污染。报告必须写明是哪一面、哪条断言。

过程断言只读调用日志,不读轨迹(ADR-0005)。轨迹只服务于可信度检查。

### scenario 是数据目录

```
skill-tests/
├── scenarios/<id>/
│   ├── scenario.json     # prompt
│   ├── materials/        # 可选，给被测 agent 读
│   ├── preset.mjs        # 可选，声明要建的任务
│   └── assert.mjs        # 结局断言
├── probes/<id>/          # 探针，跑完即删
└── README.md             # 写测试用例的流程
```

`skill-tests/` 而不是 `tests/`：避免与 `npm run test:harness`（harness 自己的单元测试）混淆。`harness/` 是机器，`skill-tests/` 是被测的数据。

加一条 scenario = 加一个目录，harness 一行不改。

### 断言是模块，返回结果数组

`assert.mjs` 默认导出一个函数，收 `{tasks, created, calls, session}`，返回 `{ok, name, expected, actual}[]`，空数组即通过。返回数组而不是抛异常，一次跑出所有失败项。`tasks` 就是终态快照——探针与正式跑共用一份结构，探针跑出来的 `state.json` 可以直接拿去调试断言。

断言按**字段**定位任务，不按顺序猜。`created` 条目带 `origin: 'preset' | 'agent'` 区分来源。

### 预设走真 CLI，与 shim 记同一份账本

`preset.mjs` 声明要建的任务，在会话启动前由 harness 用真 CLI 执行，不经 shim（shim 是给被测 agent 用的）。建出的 id 立刻写进同一份 `created.ndjson`，于是自动清场与 `--clean` 都管得到。若另起一套记录，按 ADR-0010"只认账本"就永远清不掉——那是 ADR-0006 误删事故的反面。

`preset.mjs` 里的清单 id 必须是**本次 run 实际用的那一个**，不是仓库里的默认常量。本次清单由环境变量决定，`run.mjs` 用它建沙箱、也用它传给清场；preset 若写死默认常量，在环境变量覆盖时会建到清场的视野之外——账本里有、清场快照里没有，成为删不掉的孤儿。

两条约束：

1. **harness 把本次 run 的清单交给 preset**，不让它自己取。具体形态（函数参数还是别的）是实现细节，不在本 ADR 定。
2. **harness 加载 preset 时校验每条命令的目标 ∈ 本次清单集合**，越界就拒绝执行该 run，不进入会话。这是信任边界——写错一个 id 就是往真实清单里写数据。

校验必须**复用 `guard.mjs` 的逐命令目标解析**（`decide(argv, allowedProjects)` 与 `WRITE_COMMANDS` 表），不能按字面扫 24 位十六进制串：`task complete <projectId> <taskId>` 两个参数同形，`task update` 的 taskId 也同形，扫字面会误拒合法 preset；只看 `--project` 又会漏掉位置参数目标（`task complete`/`delete`、`project update`、`task move --from/--to`）。

import 一个常量数组**并不能**阻止同文件里写字符串字面量，所以「语法上不可能」这个论证不成立，校验必须真的发生在运行时。判据是 shim 用的同一份表，preset 与被测 agent 的写入走同一套越界定义。

### 探针是没写断言的 scenario

不另造 `--probe` 开关。探针跑完整链路，产出轨迹、调用日志与终态快照供人写断言，跑完删掉目录。`probes/` 与 `scenarios/` 分开，肉眼可见有没有残留。

**`scenarios/<id>/` 缺 `assert.mjs` 时报错退出，不跑会话。** 两个目录的区分就是「有没有断言」：跳过会让漏写或误删断言的用例静默退出回归网，而退出码仍是 0。没写完的用例放 `probes/`，它本来就不参与判定。

## 后果

- `harness/README.md` 的"断言不进 scenario 目录"要改写，换成"沙箱建在 `%TEMP%`，`skill-tests/` 不在 agent 的视野里"。
- 可信度检查的现有判据（日志条数 ≥ 命令调用数）只比条数，抓不到"3 次调用里 1 次绕过、另 2 次各跑 2 条 dida"这种总数反多的情况。要真正抓住需要逐调用比对，另开 issue。
- 每条 scenario 只清自己。上一次失败的残留由操作者用 `--clean <runId>` 收尾，harness 不扫描、不检测（ADR-0010）。
- 链式 scenario（一条建、另一条查）不做：账本按 runId 隔离，后半条既断言不了也清不掉前半条的数据；单跑一条也必然失败。需要前置数据时用预设。
