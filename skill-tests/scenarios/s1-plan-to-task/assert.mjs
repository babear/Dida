// 断言按字段定位任务，不按顺序猜：agent 建了几条、以什么顺序建都不该影响判断。
// 账本里取不到的任务是 null（建了又被删），也要能在结果里看见。
export default function assert({ tasks }) {
  const live = tasks.filter(Boolean);
  const parents = live.filter((task) => !task.parentId);
  const children = live.filter((task) => task.parentId);
  const parent = parents[0];
  const missing = tasks.flatMap((task, index) => (task ? [] : [index]));

  return [
    {
      ok: missing.length === 0,
      name: '账本里的任务都还在',
      expected: `${tasks.length} 条都在`,
      actual: missing.length === 0 ? '都在' : `${missing.length} 条取不到（账本第 ${missing.join('、')} 条）`,
    },
    {
      ok: parents.length === 1,
      name: '恰好一条父任务',
      expected: 1,
      actual: parents.length,
    },
    {
      ok: parent?.kind === 'TEXT',
      name: '父任务是普通任务而不是检查事项列表',
      expected: 'TEXT',
      actual: parent?.kind ?? '（没有父任务）',
    },
    {
      ok: typeof parent?.content === 'string' && parent.content.trim() !== '',
      name: '父任务正文非空',
      expected: '非空',
      actual: parent ? (parent.content || '（空）') : '（没有父任务）',
    },
    {
      ok: (parent?.childIds?.length ?? 0) === 5,
      name: '父任务挂着 5 条真实子任务',
      expected: 5,
      actual: parent?.childIds?.length ?? 0,
    },
    {
      ok: (parent?.items?.length ?? 0) === 0,
      name: '父任务没有检查事项',
      expected: 0,
      actual: parent?.items?.length ?? 0,
    },
    {
      ok: children.length === 5,
      name: '5 条任务挂在父任务下',
      expected: 5,
      actual: children.length,
    },
    {
      ok: children.every((child) => child.kind === 'TEXT'),
      name: '每条子任务都是普通任务',
      expected: '全部 TEXT',
      actual: children.map((child) => child.kind).join('、') || '（没有子任务）',
    },
  ];
}
