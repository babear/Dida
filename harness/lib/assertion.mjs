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
// evaluated 区分「用例自己算出了结论」与「用例根本没算出来」——后者是用例缺陷，
// 不是 skill 缺陷，上层要分开判。
// 坏元素也算「没算出来」：它指向用例写错了，不是 skill 没做到。用 Array.from
// 而不是 .map ——稀疏数组的空位在 map 里会被跳过，`new Array(5)` 会让 every
// 一路放行、直接判通过。
export async function runAssert(assertionFn, input) {
  let results;
  try {
    results = await assertionFn(input);
  } catch (error) {
    return { evaluated: false, results: [{ ok: false, name: '断言执行抛异常', expected: '不抛异常', actual: error.message }] };
  }
  if (!Array.isArray(results)) {
    return { evaluated: false, results: [{ ok: false, name: '断言应返回数组', expected: '数组', actual: typeof results }] };
  }
  const normalized = Array.from(results, normalizeResult);
  const malformed = normalized.some((result) => result.malformed);
  return {
    evaluated: !malformed,
    results: normalized.map(({ malformed: _ignored, ...result }) => result),
  };
}

// 一条 scenario 的结局判定，五个状态照 ADR-0012：skipped（会话没跑完）、
// invalid（结果不可用，看 cause 决定重跑还是查代码）、broken（用例有缺陷）、
// failed（skill 没做到）、passed。
//
// 「评估」与「判定」是两件事（ADR-0012）：只要事实存在就去算，短路只决定最终 status。
// `state.json` 的写入与会话是否正常结束无关，所以只要快照取到了，结局断言就该评估：
// 那次运行的断言结论恰恰是最该看到的证据，丢掉它等于把一次真实的 skill 回归
// 变成一句「疑似绕过」。一次 `Get-ChildItem` 就足以触发可信度检查，这不是偶发代价。
export async function decideAssertion({
  completed, crossCheck, stateFailed = false, stateError = null, assertionFn, input,
}) {
  const crossFailure = crossCheckFailure(crossCheck);
  // 先算，再决定 status。
  const evaluated = stateFailed ? null : await runOutcome({ stateFailed, stateError, assertionFn, input });
  const withEvaluated = (verdict) => (evaluated ? { ...verdict, evaluated } : verdict);

  if (crossFailure) {
    // 两个都失败时，快照错误本身也是证据，别让它只活在控制台那一行。
    const detail = stateFailed
      ? `${crossFailure.detail}\n另外，终态快照也取不到：${stateError}`
      : crossFailure.detail;
    return withEvaluated({ ...crossFailure, detail });
  }

  // 会话没跑完：status 是「没正常收尾」而不是「skill 没做到」，结论仍留在 evaluated 里。
  if (!completed) return withEvaluated({ status: 'skipped', results: [] });

  return evaluated ?? runOutcome({ stateFailed, stateError, assertionFn, input });
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
async function runOutcome({ stateFailed, stateError, assertionFn, input }) {
  if (stateFailed) {
    return {
      status: 'invalid',
      cause: 'state',
      detail: `取终态快照失败：${stateError}。这是基础设施故障，重跑一次。`,
      results: [{ ok: false, name: '终态快照不可用', expected: '能列出测试清单', actual: stateError }],
    };
  }

  try {
    const { evaluated, results } = await runAssert(assertionFn, input);
    if (!evaluated) {
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
