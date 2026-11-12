import { readCreated } from './created.mjs';

// 退出码非零但 stdout 是合法 JSON 时照样收下：真 CLI 在错误路径上会带一行 libuv
// 断言导致非零退出，按退出码一刀切会把拿到的任务全判成"列清单失败"。
export function listTasks(dida, projectId) {
  const result = dida.run(['task', 'filter', '--projects', projectId, '--json']);
  const text = (result.stdout ?? '').trim();
  try {
    return text ? JSON.parse(text) : [];
  } catch {
    throw new Error(`列清单 ${projectId} 的任务失败：${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
}

export function snapshotProjects(dida, projects) {
  return Object.fromEntries(projects.map((id) => [id, listTasks(dida, id)]));
}

// 只算账不动手：账本里的 id 在清单里出现，就是要删的那条。
// 清单里其它任务根本不进入这个函数的视野——别人的任务不归本 run 管。
// 删除目标一律取**实际枚举到的**清单，账本里记的只用来交叉核对：
// 两者不一致说明 agent 建完之后把任务移到了别的清单，报出来但仍按实况删。
export function planCleanup(created, tasksByProject) {
  const recorded = new Map(created.map((entry) => [entry.id, entry]));
  const deletes = [];
  const mismatched = [];

  for (const [actualProjectId, tasks] of Object.entries(tasksByProject)) {
    for (const task of tasks) {
      const entry = recorded.get(task.id);
      if (!entry) continue;
      if (entry.projectId && entry.projectId !== actualProjectId) {
        mismatched.push({ id: task.id, recordedAt: entry.projectId, actual: actualProjectId });
      }
      deletes.push({ projectId: actualProjectId, id: task.id });
    }
  }

  return { deletes, mismatched };
}

export function cleanRun({ dida, projects, createdFile }) {
  const created = readCreated(createdFile);
  if (created.length === 0) return { deleted: [], failed: [], remaining: [], mismatched: [] };

  const tasksByProject = snapshotProjects(dida, projects);
  const plan = planCleanup(created, tasksByProject);

  const deleted = [];
  const failed = [];
  for (const { projectId, id } of plan.deletes) {
    const result = dida.run(['task', 'delete', projectId, id]);
    if (result.exitCode === 0) deleted.push(id);
    else failed.push({ projectId, id, stderr: result.stderr.trim() });
  }

  // 自查：账本里的 id 删完之后不该还在。还在说明删除没生效，报出来而不是假装清干净了。
  // created.ndjson 本身不清空：它是"这次运行建过什么"的取证材料，事后还要能翻。
  const after = snapshotProjects(dida, projects);
  const alive = new Set(Object.values(after).flat().map((task) => task.id));
  const remaining = created.map((entry) => entry.id).filter((id) => alive.has(id));

  return { deleted, failed, remaining, mismatched: plan.mismatched };
}
