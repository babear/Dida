// 测试清单：所有写入必须落在这两个清单里（见 GLOSSARY.md）。
// 允许用环境变量覆盖，但覆盖成空时退回默认——一次运行没有测试清单是不可用的状态。
export const TEST_PROJECTS = ['69abc459ebbdbd00000009f0', '59f736cae4b060e424059e3b'];

export function resolveTestProjects(env = process.env) {
  const raw = env.DIDA_TEST_PROJECTS;
  if (!raw) return TEST_PROJECTS;
  const parsed = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : TEST_PROJECTS;
}
