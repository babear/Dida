import { readCreated } from './created.mjs';

// 运行前检查：测试清单必须为空。不为空时只报告，绝不删。
export function inspectProjects(projects, tasksByProject) {
  const foreign = [];
  for (const projectId of projects) {
    for (const task of tasksByProject[projectId] ?? []) {
      foreign.push({ projectId, id: task.id, title: task.title ?? null });
    }
  }
  return { ok: foreign.length === 0, foreign };
}

// 清场计划：只认 created.json 里的 id。清单里出现任何未记账的任务就整单放弃。
export function planCleanup(created, tasksByProject) {
  const recorded = new Map(created.map((entry) => [entry.id, entry]));
  const foreign = [];
  const deletes = [];

  for (const [projectId, tasks] of Object.entries(tasksByProject)) {
    for (const task of tasks) {
      const entry = recorded.get(task.id);
      if (!entry) foreign.push({ projectId, id: task.id, title: task.title ?? null });
      else deletes.push({ projectId: entry.projectId ?? projectId, id: task.id });
    }
  }

  if (foreign.length > 0) return { aborted: true, deletes: [], foreign };
  return { aborted: false, deletes, foreign };
}

export function listTasks(dida, projectId) {
  const result = dida.run(['task', 'filter', '--projects', projectId, '--json']);
  if (result.exitCode !== 0) {
    throw new Error(`列清单 ${projectId} 的任务失败：${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : [];
}

export function snapshotProjects(dida, projects) {
  return Object.fromEntries(projects.map((id) => [id, listTasks(dida, id)]));
}

export function cleanRun({ dida, projects, createdFile }) {
  const created = readCreated(createdFile);
  if (created.length === 0) return { aborted: false, deleted: [], failed: [], foreign: [] };

  const tasksByProject = snapshotProjects(dida, projects);
  const plan = planCleanup(created, tasksByProject);
  if (plan.aborted) return { ...plan, deleted: [], failed: [] };

  const deleted = [];
  const failed = [];
  for (const { projectId, id } of plan.deletes) {
    const result = dida.run(['task', 'delete', projectId, id]);
    if (result.exitCode === 0) deleted.push(id);
    else failed.push({ projectId, id, stderr: result.stderr.trim() });
  }
  // created.json 不清空：它是"这次运行建过什么"的取证材料，事后还要能翻。
  // 已删掉的 id 下次再清场时在清单里找不到，planCleanup 会自然跳过。
  return { aborted: false, deleted, failed, foreign: [] };
}
