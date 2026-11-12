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

// 一条 scenario 的结局判定。三类的分界照 ADR-0012：用例缺陷判 broken（去修用例），
// 结果不可归因判 invalid（重跑），断言不通过判 failed（去改 skill）。
export async function decideAssertion({ completed, stateError, assertionFn, input }) {
  if (!completed) return { status: 'skipped', results: [] };

  if (stateError) {
    return {
      status: 'invalid',
      detail: `取终态快照失败：${stateError}`,
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
