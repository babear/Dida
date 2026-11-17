# skill-tests

被测 skill 的测试用例数据。机器在 `harness/`，这里只有数据。

> **这份文档里 `assert.mjs`、`preset.mjs` 与 `state.json` 都已实现。** 现在 `scenario.json`、`materials/`、`preset.mjs`、`assert.mjs` 都能跑：缺 `assert.mjs` 的用例会被判「用例配置错误」并直接退出、不开会话；`preset.mjs` 写错（越界、指向已有任务、空操作、执行失败）同样拒绝该 run、不进入会话。探针的设计见 ADR-0015，过程断言归 #8。

```
skill-tests/
├── scenarios/<id>/     # 正式用例，参与全量判定
├── probes/<id>/        # 探针，取到快照即止、不清场，断言写好后搬进 scenarios/
└── README.md
```

## 一条 scenario 由什么组成

| 文件 | 作用 | 谁看 |
|---|---|---|
| `scenario.json` | `prompt`：用户原话，唯一给被测 agent 的文本输入 | 被测 agent |
| `materials/` | 可选。用户原话里要引用的文件，整体复制进运行目录的 `work/materials/` | 被测 agent |
| `preset.mjs` | 可选。声明要建的任务，会话前由 harness 用真 CLI 执行 | 无 |
| `assert.mjs` | 结局断言。默认导出 `{tasks, created, calls, session} => 结果数组` | 无 |

判定分三面、按**严格顺序**短路：可信度检查 → 结局断言 → 过程断言，前一面不过就不算后面；会话正常结束是前置门。见 `harness/README.md` 的「判定」与 ADR-0014。

`scenarios/<id>/` 里**必须有 `assert.mjs`**。缺了不跑会话，直接报错退出——否则漏写或误删断言的用例会让回归网静默少一条。还没写断言的用例放 `probes/`，不放在 `scenarios/`。

## 写一条新 scenario 的流程

### 1. 先在 `probes/<id>/` 写，不写断言

```
skill-tests/probes/<id>/
├── scenario.json
├── materials/          # 如果需要
└── preset.mjs          # 如果需要前置数据
```

`scenario.json` 只有 `prompt`：

```json
{
  "prompt": "Test_1 清单里有一条『买气罐』，把它的标题改成『买气罐和防蚊液』。"
}
```

原话的约束：

- 可以点名测试清单（`Test_1` / `Test_2`）。必须点名——写命令的 `--project` 必填，且目标必须 ∈ 测试清单集合，不点名 agent 猜不出来，每次写入都会被拒。
- 不得出现「测试」「评测」「断言」「期望」这类字样，也不得写出期望结果。原话要像一个真实用户在提要求。
- 不得包含反馈原文——断言要基于实测行为，不是缺陷报告的描述。

### 2. 需要前置数据时写 `preset.mjs`

`preset.mjs` 只**声明**要跑哪些命令，不自己执行：

```js
export default (projects) => [
  ['task', 'create', '--project', projects[0], '--title', '买气罐', '--content', '户外用'],
];
```

- **清单从参数拿，不要 import 默认常量。** 本次 run 的清单可能被环境变量覆盖，用默认常量会建到清场的视野外，成为删不掉的孤儿。
- **不能指向已有任务。** `--parent-id`、`task update --id`、`task delete`、`task move --task`、`comment add` 指向的任务不在账本里，写错就改到账本之外的数据。preset 里出现这类参数会被拒绝，等占位符方案落地后才放开。
- **只支持 `task create`。** 账本记得下、清场收得回的只有它建出的任务 id。别的写命令（`project update`、`project delete`、`project column create` …）改了真实数据却记不了账，一律拒绝。
- **不能是空操作。** `--help`、裸命令组、只读命令这类 argv 什么都不建，会被判为错误而不是静默通过。
- **不支持无目标写命令**（`project create` 等）：建清单会突破测试清单集合的边界。需要新清单时先手工建好，再加进 `DIDA_TEST_PROJECTS`。
- 目标清单必须 ∈ 本次清单集合，越界拒绝该 run。
- 它建的任务和被测 agent 建的一样进本 run 的账本（`origin: 'preset'`），清场管得到。
- 只造数据结构，不造语义提示。preset 建的东西被测 agent 看得到，标题写得像答案等于给提示。
- 预设失败时**不清场**：建出的任务留在 `runs/<runId>/created.ndjson`，用 `--clean <runId>` 收尾。

**不要做链式 scenario**（一条建、另一条查）。账本按 runId 隔离，后半条既断言不了也清不掉前半条的数据；单跑一条也必然缺前置数据。需要前置数据就用 preset。

### 3. 跑探针

```bash
node harness/run.mjs --scenario <id>
```

探针与 scenario 共用运行目录、会话、账本与可信度检查，分岔在取到终态快照之后：探针到此结束，不跑断言、也不清场（ADR-0015）。所以一次探针成功跑完的结论是 `sampled` 而不是 `passed`，退出码 0 只代表「这份样本可用」。

读完 `runs/<runId>/` 下的三件事实：

| 文件 | 看什么 |
|---|---|
| `state.json` | 账本里每条任务的完整现状。按测试清单枚举定位，枚举不到才回退账本的 `projectId`。断言读的就是它。探针也产出它，取到即止 |
| `calls.ndjson` | 被测 agent 实际调了哪些 dida 命令，argv 是解析后的数组 |
| `trace.ndjson` | agent 的完整步骤。只在需要看它为什么这么做时读 |

探针永不清场，任务与运行目录都留在现场；确认完用 `--clean <runId>` 收尾。

### 4. 据此写 `assert.mjs`

```js
export default function assert({ tasks, created, calls, session }) {
  const parents = tasks.filter((t) => t?.kind === 'TEXT' && t.childIds?.length === 5);
  return [
    { ok: parents.length === 1, name: '恰好一个父任务带 5 条子任务',
      expected: 1, actual: parents.length },
    { ok: (parents[0]?.content ?? '') !== '', name: '父任务正文非空',
      expected: '非空', actual: parents[0]?.content ?? '(空)' },
  ];
}
```

- 返回数组，空数组即通过。一次跑出所有失败项，不用修一条跑一条。
- 每项 `{ok, name, expected, actual}`：`expected` 与 `actual` 会原样进报告，人不用翻日志就知道差在哪。
- 断言抛异常或返回非数组时，harness 会把它折成一条失败结果，不会中断整次运行。
- **断言自己也要有测试**：放一份 `assert.test.mjs` 在同一个目录，用构造数据验证它对正确结局全绿、对错误结局点到具体那一条。它不烧 API，`npm run test:scenarios` 跑它。
- **按字段定位任务**，不按顺序猜。别写 `tasks[0]`——你不知道 agent 建了几条、以什么顺序建。
- `created` 条目带 `origin: 'preset' | 'agent'`，要区分来源时用它。
- `tasks` 里取不到的任务是 `null`（账本有 id 但任务被删了），断言要能处理。
- 结局断言只需要 `tasks`。过程断言归 harness 全局，不要在 `assert.mjs` 里重写。

### 5. 搬到 `scenarios/`，删掉探针

```bash
git mv skill-tests/probes/<id> skill-tests/scenarios/<id>
```

探针的源目录跑完就删，运行现场按需用 `--clean` 收尾。`probes/` 里还留着源目录说明流程没走完，全量运行的汇总末尾会提醒。

### 6. 验证红绿

```bash
node harness/run.mjs --scenario <id>   # 当前 skill 上必须红（退出码 1）
```

红不了说明这条 scenario 复现不了缺陷，是假测试——回第 1 步重写原话。改过 skill 之后再跑一次，必须绿（退出码 0）。这就是「复现价」。

## 常见的坑

- **原话里写了期望值**，agent 照着抄。断言测的应该是 skill 引导出的行为，不是 agent 的阅读理解。
- **断言读了 `task filter` 的全量结果**。只认账本里的 id——清单里别人的任务不在视野内（ADR-0010）。
- **preset 标题写得太具体**，泄漏了答案。
- **scenario 依赖上一条的产物**。见上面「不要做链式 scenario」。
- **一条 scenario 对应多个缺陷**。断言红的时候不知道是哪条缺陷没修好，拆开。
