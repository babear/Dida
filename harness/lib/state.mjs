// 终态快照：账本里每条 id 按 id 取回现状。取不到的记 null——
// 账本有记录说明本 run 建过它，任务却没了，这是断言要能看见的事实，不是错误。
// 退出码非零但 stdout 是合法 JSON 时照样收下：真 CLI 在错误路径上会带一行 libuv
// 断言导致非零退出，按退出码一刀切会把拿到的任务误记成 null。
export function buildState({ dida, created }) {
  return created.map((entry) => {
    const result = dida.run(['task', 'get', entry.projectId, entry.id, '--json']);
    try {
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
  });
}
