// 测试清单集合：shim 的越界写入防护与清场共用这一份（见 GLOSSARY.md）。
// 允许用环境变量覆盖，但覆盖成空时退回默认——一次运行没有测试清单是不可用的状态。
export const TEST_PROJECTS = ['69abc459ebbdbd00000009f0', '59f736cae4b060e424059e3b'];

// 只做切分与去空白，不提供默认值——shim 需要区分"没配"与"配了空"。
export function parseProjectList(raw) {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolveTestProjects(env = process.env) {
  const parsed = parseProjectList(env.DIDA_TEST_PROJECTS);
  return parsed.length > 0 ? parsed : TEST_PROJECTS;
}
