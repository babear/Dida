import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';


// 缺文件返回 null 而不是抛错：调用方要能区分「没写断言」（用例配置错误）
// 与「断言模块坏了」（同样判失败，但原因不同）。
async function loadAssertionFile(file) {
  if (!fs.existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.default !== 'function') {
    throw new Error(`${file} 没有默认导出的函数`);
  }
  return mod.default;
}

export async function loadAssert(scenarioDir) {
  return loadAssertionFile(path.join(scenarioDir, 'assert.mjs'));
}

// 过程断言按**一条规则一个目录**组织：scenarios/<id>/process/<rule-id>/，
// 里面放 rule.mjs（判据）、RULE.md（问题说明）、evidence.ndjson（依据的原始调用序列）。
// 规则与它的论据放在一起，加一条规则就加一个目录。
//
// 缺省允许：没有 process/ 或里面一条规则都没有，就不判过程这一面——
// 一条用例未必有已确认的过程缺陷，强行要求会让作者为了填满目录写一条没有证据的规则。
export async function loadProcessAssert(scenarioDir) {
  const rulesDir = path.join(scenarioDir, 'process');
  if (!fs.existsSync(rulesDir)) return null;

  const ids = fs.readdirSync(rulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (ids.length === 0) return null;

  const rules = [];
  for (const id of ids) {
    const file = path.join(rulesDir, id, 'rule.mjs');
    if (!fs.existsSync(file)) {
      // 目录建了却没写判据：静默跳过会让「以为加了一条规则」变成一次无声的空跑。
      throw new Error(`${path.join(rulesDir, id)} 里没有 rule.mjs`);
    }
    rules.push({ id, fn: await loadAssertionFile(file) });
  }

  // 每条结果带上规则 id：报告要能点名是哪条规则红，而不是只有一句话。
  return async (input) => {
    const results = [];
    for (const { id, fn } of rules) {
      const produced = await fn(input);
      if (!Array.isArray(produced)) return produced;
      results.push(...produced.map((result) => (
        result && typeof result === 'object' ? { ...result, rule: id } : result
      )));
    }
    return results;
  };
}

// 非对象或缺 ok 的元素归一化成一条失败结果：`[null]`（例如 `tasks.map(t => t && {...})`
// 的产物）会让上层 `results.every(r => r.ok)` 抛 TypeError，而那时会话已结束、
// manifest 还没落盘、清场还没执行——整场景的事实就丢了。
// malformed 只用来让调用方知道「用例写错了」，不写进给断言作者看的结果里。
function normalizeResult(result, index) {
  if (result && typeof result === 'object' && typeof result.ok === 'boolean') return result;
  return {
    malformed: true,
    ok: false,
    name: `断言结果第 ${index + 1} 项形状不对`,
    expected: '带布尔 ok 的对象',
    actual: result === undefined ? 'undefined' : JSON.stringify(result),
  };
}

// 断言抛错、返回非数组、或返回数组里混了坏元素，都折成失败结果：
// 一次运行要跑出所有失败项，不能因为断言自己写崩了就丢了整场景的结论。
// usable 区分「用例自己算出了结论」与「用例根本没算出来」——后者是用例缺陷，
// 不是 skill 缺陷，上层要分开判。
// 坏元素也算「没算出来」：它指向用例写错了，不是 skill 没做到。用 Array.from
// 而不是 .map ——稀疏数组的空位在 map 里会被跳过，`new Array(5)` 会让 every
// 一路放行、直接判通过。
export async function runAssert(assertionFn, input) {
  let results;
  try {
    results = await assertionFn(input);
  } catch (error) {
    return { usable: false, results: [{ ok: false, name: '断言执行抛异常', expected: '不抛异常', actual: error.message }] };
  }
  if (!Array.isArray(results)) {
    return { usable: false, results: [{ ok: false, name: '断言应返回数组', expected: '数组', actual: typeof results }] };
  }
  const normalized = Array.from(results, normalizeResult);
  const malformed = normalized.some((result) => result.malformed);
  return {
    usable: !malformed,
    results: normalized.map(({ malformed: _ignored, ...result }) => result),
  };
}

// 快照的三种状态：没取（判定链在前一面就停了）、取了但失败、取到了。
// `state` 为空数组只对后两种成立——「没取」也落 []，但调用方靠 status 分辨。
function notTaken() {
  return { status: 'not-taken', state: [], error: null };
}

// 两条路径共享的前三步（ADR-0015）：会话门 → 可信度检查 → 取快照。
// 探针走完它就直接用这个结果作结论——`sampled` 就是「前两步都过了、快照取到了」；
// scenario 则拿它继续跑结局断言。所以这里只产出**事实**，不产出任何判定：
// `sampled` 不是 `passed`，它只说明这份样本可用，不说明 skill 是对的。
//
// 会话正常结束是判定链的前置门（ADR-0014）：没正常结束时判定链根本没开始，
// 不取快照、不跑断言，也就没有可信度检查可言——一次「会话没跑完」的运行没有产出可判的事实。
//
// 可信度检查同理：它不过，说明这次运行的事实基础不成立，后面各面算出来的东西没有参考价值。
// 所以只返回第一面的结论，不取快照、不调断言模块——一次运行只给一个结论。
//
// 快照在结局断言这一刻取，不在会话结束时取（ADR-0014）：它的唯一消费者是结局断言，
// 前面两面都过了才轮得到它。取不到是基础设施故障，判 invalid（cause: state）并停住，
// 不拿 [] 去跑断言——那组结论只会把人引向错误的方向。
export function takeSample({ completed, crossCheck, takeSnapshot }) {
  if (!completed) {
    return { status: 'incomplete', results: [], snapshot: notTaken() };
  }

  const crossFailure = crossCheckFailure(crossCheck);
  if (crossFailure) return { ...crossFailure, snapshot: notTaken() };

  const snapshot = takeSnapshot();
  // 只认 'ok'：takeState 现在只产 ok / failed，但这里按「不是 ok 就停」写，
  // 多一个状态（比如将来某种取不到）也不会带着空清单滑进下游。
  if (snapshot.status !== 'ok') {
    return {
      status: 'invalid',
      cause: 'state',
      detail: `取终态快照失败：${snapshot.error}。这是基础设施故障，重跑一次。`,
      results: [{ ok: false, name: '终态快照不可用', expected: '能列出测试清单', actual: snapshot.error }],
      snapshot,
    };
  }

  return { status: 'sampled', results: [], snapshot };
}

// 一条 scenario 的判定链后半段：结局断言 → 过程断言（ADR-0005 / ADR-0014）。
// 会话门与可信度检查已由 takeSample 做完（ADR-0015）——这里不再自己判一遍，
// 两处各判一次就会出现「共享段说没取、这里说取了」的分叉。
//
// 严格顺序短路（ADR-0014）：结局断言不过就终止，过程断言不跑——
// 没做到的话，谈有没有绕远路没有意义。
//
// 过程断言按 scenario 写，缺省允许：没写就是这条用例不做过程判定，
// 结论里如实标 evaluated: false——「未判」不能冒充「通过」。
export async function decideAssertion({ sample, assertionFn, input, processFn = null }) {
  // 缺 sample 是调用方接错了线（旧签名传的是 completed / takeSnapshot）。
  // 静默返回一个没结论的对象会让它一路滑到报告里，那里只会显示「未评断言」。
  if (!sample) throw new Error('decideAssertion 需要 sample：先调 takeSample');
  if (sample.status !== 'sampled') return sample;

  const outcome = await runOutcome(assertionFn, { ...input, tasks: sample.snapshot.state });
  if (outcome.status !== 'passed') return { ...outcome, snapshot: sample.snapshot };

  if (!processFn) {
    return {
      status: 'passed',
      process: { evaluated: false, results: [] },
      results: outcome.results,
      snapshot: sample.snapshot,
    };
  }

  // 只给调用日志：轨迹归可信度检查，快照归结局断言，都不该漏进过程断言。
  const process = await runProcess(processFn, { calls: input.calls ?? [] });
  if (process.invalid) {
    return {
      status: 'broken',
      // 报告靠 surface 区分「改这个用例的 process.mjs」还是「改 assert.mjs」。
      surface: 'process',
      detail: process.invalid,
      results: process.results,
      snapshot: sample.snapshot,
    };
  }
  return {
    status: process.ok ? 'passed' : 'failed',
    // 哪一面红的：过程断言与结局断言都会给出 failed，报告与指引不同（去改 skill，但改的不是同一处）。
    ...(process.ok ? {} : { surface: 'process' }),
    process: { evaluated: true, results: process.results },
    // 过程断言的结果不进 results：那一面没跑过时 results 只该有结局断言那几条，
    // 混在一起会让「两面都通过」与「只跑了结局断言」看起来一样。
    results: outcome.results,
    snapshot: sample.snapshot,
  };
}

// 过程断言是 scenario 自己的代码：抛异常或返回非法形状都说明用例写错了，
// 与 assert.mjs 坏掉同一个出口——判 broken，读报告的人去改 process.mjs。
async function runProcess(processFn, input) {
  let results;
  try {
    results = await processFn(input);
  } catch (error) {
    return { invalid: `过程断言执行抛异常：${error.message}`, results: [{ ok: false, name: '过程断言执行抛异常', expected: '不抛异常', actual: error.message }] };
  }
  if (!Array.isArray(results)) {
    return { invalid: '过程断言应返回数组', results: [{ ok: false, name: '过程断言应返回数组', expected: '数组', actual: typeof results }] };
  }
  const normalized = Array.from(results, normalizeResult);
  return {
    ok: normalized.every((result) => result.ok && !result.malformed),
    results: normalized.map(({ malformed: _ignored, ...result }) => result),
    ...(normalized.some((result) => result.malformed) ? { invalid: '过程断言的结果项缺布尔 ok' } : {}),
  };
}

// 可信度失败时的结论；通过时返回 null。
function crossCheckFailure(crossCheck) {
  if (!crossCheck?.status || crossCheck.status === 'consistent') return null;
  const summary = crossCheck.detail ?? '';
  const inconsistent = crossCheck.status === 'inconsistent';
  return {
    status: 'invalid',
    cause: inconsistent ? 'cross-check' : 'indeterminate',
    detail: inconsistent
      ? `轨迹里有 dida 调用在日志里找不到对应：${summary}。这些调用没走过 shim，重跑不一定能解决。`
      : `轨迹读不出可比对的调用：${summary}。先查明轨迹里为什么没有可解析的调用，重跑不一定能解决。`,
    // 两种 cause 的失败性质不同，各写各的行——用同一句会把没观测到的事实说成观测到了。
    results: inconsistent
      ? [{
        ok: false,
        name: '可信度检查',
        expected: '轨迹里的每次 dida 调用都被 shim 记录',
        actual: summary,
      }]
      : [{
        ok: false,
        name: '可信度检查',
        expected: '轨迹里有能逐条比对的 dida 调用',
        actual: `${summary}——没有比对成功，谈不上对得上对不上`,
      }],
  };
}

// 快照 → 断言。任何一步失败都折成结论，不抛。
async function runOutcome(assertionFn, input) {
  try {
    const { usable, results } = await runAssert(assertionFn, input);
    if (!usable) {
      return { status: 'broken', detail: '断言模块没给出合法的结果数组（抛异常、返回非数组，或元素缺布尔 ok）', results };
    }
    return { status: results.every((result) => result.ok) ? 'passed' : 'failed', results };
  } catch (error) {
    // 归一化本身炸了（元素的 expected 是循环引用之类）：仍要留下结论让清场照常跑。
    return {
      status: 'broken',
      detail: `断言阶段异常：${error.message}`,
      results: [{ ok: false, name: '断言阶段异常', expected: '正常完成', actual: error.message }],
    };
  }
}
