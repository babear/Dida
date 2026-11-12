import { snapshotProjects } from './cleanup.mjs';

// 终态快照：账本里每条 id 取回现状，取不到的记 null。
// 定位方式与清场一致——先按测试清单枚举再按 id 找，不信账本记的 projectId：
// agent 可以用 task move 把任务挪到别的测试清单，也可能重复给 --project
// （commander 取最后一个，账本记第一个）。枚举不到的才回退去直查，覆盖任务
// 建在测试清单之外的情况（真 CLI 直接调用绕过了 shim）。
// 退出码非零但 stdout 是合法 JSON 时照样收下：真 CLI 在错误路径上会带一行 libuv
// 断言导致非零退出，按退出码一刀切会把拿到的任务误记成 null。
export function buildState({ dida, created, projects }) {
  if (created.length === 0) return [];

  const byId = new Map();
  for (const tasks of Object.values(snapshotProjects(dida, projects))) {
    for (const task of tasks) byId.set(task.id, task);
  }

  return created.map((entry) => {
    if (byId.has(entry.id)) return byId.get(entry.id);
    // 清单枚举不到时回退到账本记的清单直查：任务可能建在测试清单之外
    // （真 CLI 直接调用绕过了 shim），那种情况枚举看不到但它确实存在。
    const result = dida.run(['task', 'get', entry.projectId, entry.id, '--json']);
    try {
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
  });
}
