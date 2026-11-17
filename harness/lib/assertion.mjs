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

// 一条 scenario 的结局判定，五个状态见 ADR-0012（三面拆分）与本 ADR-0014（前置门与顺序）：
// incomplete（前置门：会话没正常结束）、invalid（结果不可用，看 cause 决定重跑还是查代码）、
// broken（用例有缺陷）、failed（skill 没做到）、passed。
//
// 会话正常结束是判定链的前置门，不属于三面（ADR-0014）：没正常结束时判定链根本没开始，
// 不取快照、不跑断言，也就没有可信度检查可言——一次「会话没跑完」的运行没有产出可判的事实。
//
// 可信度检查同理：它不过，说明这次运行的事实基础不成立，后面各面算出来的东西没有参考价值。
// 所以只返回第一面的结论，不取快照、不调断言模块——一次运行只给一个结论。
//
// 快照在结局断言这一刻取，不在会话结束时取（ADR-0014）：它的唯一消费者是结局断言，
// 前面两面都过了才轮得到它。取不到是基础设施故障，判 invalid（cause: state）并停住，
// 不拿 [] 去跑断言——那组结论只会把人引向错误的方向。
//
// 返回值里的 snapshot 是**这次判定实际用的快照**，调用方据此落 manifest 与报告，
// 不必也不该自己再取一次：「没取」与「取了」的事实只有判定链知道。
export async function decideAssertion({
  completed, crossCheck, takeSnapshot, assertionFn, input,
}) {
  if (!completed) return { status: 'incomplete', results: [], snapshot: notTaken() };

  const crossFailure = crossCheckFailure(crossCheck);
  if (crossFailure) return { ...crossFailure, snapshot: notTaken() };

  const snapshot = takeSnapshot();
  // 只认 'ok'：takeState 现在只产 ok / failed，但这里按「不是 ok 就停」写，
  // 多一个状态（比如将来某种取不到）也不会带着空清单滑进断言。
  if (snapshot.status !== 'ok') {
    return {
      status: 'invalid',
      cause: 'state',
      detail: `取终态快照失败：${snapshot.error}。这是基础设施故障，重跑一次。`,
      results: [{ ok: false, name: '终态快照不可用', expected: '能列出测试清单', actual: snapshot.error }],
      snapshot,
    };
  }

  return { ...(await runOutcome(assertionFn, { ...input, tasks: snapshot.state })), snapshot };
}

// 「没取」：没有 state.json，清单条数无意义（null）。
function notTaken() {
  return { status: 'not-taken', state: [], error: null };
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
