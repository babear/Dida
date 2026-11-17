import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

// 一条 scenario 的结局判定：拿一份已经取好的快照跑断言。
// 会话门与可信度检查已由 takeSample 做完（ADR-0015）——这里不再自己判一遍，
// 两处各判一次就会出现「共享段说没取、这里说取了」的分叉。
export async function decideAssertion({ sample, assertionFn, input }) {
  // 缺 sample 是调用方接错了线（旧签名传的是 completed / takeSnapshot）。
  // 静默返回一个没结论的对象会让它一路滑到报告里，那里只会显示「未评断言」。
  if (!sample) throw new Error('decideAssertion 需要 sample：先调 takeSample');
  if (sample.status !== 'sampled') return sample;

  return { ...(await runOutcome(assertionFn, { ...input, tasks: sample.snapshot.state })), snapshot: sample.snapshot };
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
      ? `调用日志与轨迹对不上：${summary}。先查明是偶发还是系统性绕过，重跑不一定能解决。`
      : `轨迹读不出可解析的事件，无从比对：${summary}。先查明轨迹里为什么没有可解析的行，重跑不一定能解决。`,
    // 两种 cause 的失败性质不同，各写各的行——用同一句会把没观测到的事实说成观测到了。
    results: inconsistent
      ? [{
        ok: false,
        name: '可信度检查',
        // 不写「调用都能归因」那种带结论的期望：条数不等本身说明不了有没有调用没被记录。
        expected: '日志条数与轨迹里的命令调用数相符',
        actual: `${summary}（条数不等不等于有调用没被记录，多出来的可能是文件操作）`,
      }]
      : [{
        ok: false,
        name: '可信度检查',
        expected: '轨迹里有可解析的事件，能拿来比对',
        actual: `${summary}——没有比对过条数，也就谈不上对得上对不上`,
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
