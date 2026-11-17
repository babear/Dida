// 依据 2026-11-17 探针取样（run 2026-11-17T00-14-05-962Z-0f6249）：
// agent 建出的任务是 kind=CHECKLIST、5 条 items、说明写在 content、desc 不存在。
// 断言按字段定位，不按顺序猜（skill-tests/README.md）。
export default function assert({ tasks }) {
  const task = tasks.find((t) => t && t.kind === 'CHECKLIST');

  if (!task) {
    return [{
      ok: false,
      name: '建出了一条 CHECKLIST 任务',
      expected: 'kind 为 CHECKLIST 的任务',
      actual: tasks.map((t) => t?.kind ?? null),
    }];
  }

  const items = Array.isArray(task.items) ? task.items : [];
  const content = typeof task.content === 'string' ? task.content : '';

  return [
    {
      ok: items.length === 5,
      name: '检查事项恰好 5 条',
      expected: 5,
      actual: items.length,
    },
    {
      ok: items.every((item) => typeof item?.title === 'string' && item.title.length > 0),
      name: '每条检查事项都有标题',
      expected: '5 条非空标题',
      actual: items.map((item) => item?.title ?? null),
    },
    // #25 的核心：说明该写在哪个字段。实测 agent 写进了 content 且没写 desc，
    // 这条断言锁住那个行为——说明必须落在 content 上。
    {
      ok: content.length > 0,
      name: '说明写进了 content',
      expected: '非空',
      actual: content || '(空)',
    },
    {
      ok: !task.desc,
      name: '没有把说明写进 desc',
      expected: 'desc 为空或不存在',
      actual: task.desc ?? '(不存在)',
    },
  ];
}
