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

// 断言抛错或返回非数组都折成一条失败结果：一次运行要跑出所有失败项，
// 不能因为断言自己写崩了就丢了整场景的结论。
export async function runAssert(assertionFn, input) {
  if (typeof assertionFn !== 'function') {
    return [{ ok: false, name: '断言模块不可用', expected: '一个函数', actual: typeof assertionFn }];
  }
  let results;
  try {
    results = await assertionFn(input);
  } catch (error) {
    return [{ ok: false, name: '断言执行抛异常', expected: '不抛异常', actual: error.message }];
  }
  if (!Array.isArray(results)) {
    return [{ ok: false, name: '断言应返回数组', expected: '数组', actual: typeof results }];
  }
  return results;
}
