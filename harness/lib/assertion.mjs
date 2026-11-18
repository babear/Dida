import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { evaluateProcessRules } from './processassert.mjs';

// 缺文件返回 null 而不是抛错：调用方要能区分「没写断言」（用例配置错误）
// 与「断言模块坏了」（同样判失败，但原因不同）。
export async function loadAssert(scenarioDir) {
  const file = path.join(scenarioDir, 'assert.mjs');
  if (!fs.existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.default !== 'function') {
    throw new Error(`${file} 没有默认导出的函数`);
  }
  return mod.default;
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
export async function decideAssertion({ sample, assertionFn, input, evaluateRules = evaluateProcessRules }) {
  // 缺 sample 是调用方接错了线（旧签名传的是 completed / takeSnapshot）。
  // 静默返回一个没结论的对象会让它一路滑到报告里，那里只会显示「未评断言」。
  if (!sample) throw new Error('decideAssertion 需要 sample：先调 takeSample');
  if (sample.status !== 'sampled') return sample;

  const outcome = await runOutcome(assertionFn, { ...input, tasks: sample.snapshot.state });
  if (outcome.status !== 'passed') return { ...outcome, snapshot: sample.snapshot };

  const process = runProcess(evaluateRules, input.calls ?? []);
  // 规则自己坏掉（抛异常 / 返回非法形状）是 harness 的缺陷：判 broken 而不是 failed，
  // 否则报告会写「绕了远路」并叫人去改 skill——改错了地方（ADR-0005 的 2026-11-18 补充）。
  if (process.error || process.threw) {
    return {
      status: 'broken',
      // 同 failed 一样要标面：报告靠它区分「改用例」还是「改 harness」。
      surface: 'process',
      detail: process.error
        ? `过程断言规则抛异常：${process.error}`
        : '过程断言规则没给出合法结果（抛异常或缺布尔 ok）：去修 harness 的规则表，不是改 skill',
      results: process.results,
      snapshot: sample.snapshot,
    };
  }
  return {
    status: process.ok ? 'passed' : 'failed',
    // 哪一面红的：过程断言与结局断言都会给出 failed，报告与指引不同（去改 skill，但改的不是同一处）。
    ...(process.ok ? {} : { surface: 'process' }),
    // 规则条数单独给出，报告据此决定写不写「过程断言 通过」——
    // 从结果数组里按名字反推属于哪一面太脆。
    process: { ruleCount: process.ruleCount },
    results: [...outcome.results, ...process.results],
    snapshot: sample.snapshot,
  };
}

// 过程规则是我们自己的代码：求值函数整体抛异常说明 harness 坏了，不是 skill 没做到。
// 折成 broken，与断言模块坏掉同一个出口——去修代码，不是去改 skill。
function runProcess(evaluateRules, calls) {
  try {
    const { ok, threw = false, results } = evaluateRules(calls);
    return { ok, threw, results, ruleCount: results.length };
  } catch (error) {
    return {
      error: error.message,
      results: [{ ok: false, name: '过程断言规则', expected: '能给出结论', actual: error.message }],
    };
  }
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
