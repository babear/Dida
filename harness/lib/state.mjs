// 终态快照：账本里每条 id 按 id 取回现状。取不到的记 null——
// 账本有记录说明本 run 建过它，任务却没了，这是断言要能看见的事实，不是错误。
export function buildState({ dida, created }) {
  return created.map((entry) => {
    const result = dida.run(['task', 'get', entry.projectId, entry.id, '--json']);
    if (result.exitCode !== 0) return null;
    try {
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
  });
}
