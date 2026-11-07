function shortRev(rev) {
  return rev ? rev.slice(0, 12) : 'unknown';
}

// skill 指纹取前 12 位：够区分一次改动，又不至于让首行长得没法读。
function shortFingerprint(sha256) {
  return sha256 ? sha256.slice(0, 12) : 'unknown';
}

function modelLine(model) {
  const requested = model?.requested_alias ?? null;
  const mapping = model?.alias_mapping ?? {};
  // 两种形态都要认：CLI 有时自报别名（sonnet），有时自报已解析的完整模型名。
  const byAlias = requested ? mapping[requested] : null;
  const byModel = requested
    ? Object.values(mapping).find((entry) => entry.model?.toLowerCase() === requested.toLowerCase())
    : null;
  const resolved = byAlias ?? byModel;
  const name = resolved?.name ?? resolved?.model ?? null;
  if (requested && name && name !== requested) return `${requested} → ${name}`;
  return requested ?? 'unknown';
}

export function renderHeader(manifest) {
  const dirty = manifest.skill?.git?.dirty ? ' (dirty)' : '';
  return [
    `skill ${shortFingerprint(manifest.skill?.sha256)} @ ${shortRev(manifest.skill?.git?.rev)}${dirty}`,
    `model ${modelLine(manifest.model)}`,
    `sandbox ${manifest.sandbox}`,
  ].join('  |  ');
}

function tableRows(entries, columns) {
  return entries.map((entry) => `| ${columns.map((column) => column(entry)).join(' | ')} |`).join('\n');
}

export function renderReport(manifest) {
  const created = manifest.created ?? [];
  const cleanup = manifest.cleanup ?? { deleted: [], failed: [], foreign: [] };
  const lines = [
    `# ${manifest.scenario}  ${manifest.run}`,
    '',
    renderHeader(manifest),
    '',
    '## 本次创建的任务',
    '',
  ];

  if (created.length === 0) {
    lines.push('（没有创建任何任务）');
  } else {
    lines.push(
      '| 任务 id | 清单 | 标题 |',
      '|---|---|---|',
      tableRows(created, [
        (e) => e.id,
        (e) => e.projectId ?? '-',
        (e) => e.title ?? '-',
      ]),
    );
  }

  lines.push('', '## 清场', '');
  if (cleanup.foreign?.length) {
    lines.push(
      '**清场已停止**：清单里有非本 run 创建的任务，未记账因此不动手。',
      '',
      '| 任务 id | 清单 | 标题 |',
      '|---|---|---|',
      tableRows(cleanup.foreign, [
        (e) => e.id,
        (e) => e.projectId ?? '-',
        (e) => e.title ?? '（无标题）',
      ]),
    );
  } else {
    lines.push(`按 created.json 删除 ${cleanup.deleted?.length ?? 0} 条，失败 ${cleanup.failed?.length ?? 0} 条。`);
  }

  lines.push('', '## 会话', '');
  lines.push(`- 退出码 ${manifest.session?.exitCode ?? 'unknown'}${manifest.session?.timedOut ? '（超时）' : ''}`);
  lines.push(`- ${manifest.session?.turns ?? '?'} 轮，$${manifest.session?.costUsd ?? '?'}`);
  lines.push(`- 调用日志 ${manifest.calls?.path ?? '-'}（${manifest.calls?.total ?? 0} 条）`);
  lines.push('', '## 摘要', '', renderSummary(manifest));
  return lines.join('\n');
}

export function renderSummary(manifest) {
  const created = manifest.created ?? [];
  const cleanup = manifest.cleanup ?? { deleted: [], failed: [], foreign: [] };
  const skill = shortFingerprint(manifest.skill?.sha256);
  const parts = [
    `scenario ${manifest.scenario} 用 skill ${skill} 跑了一次真实会话，`,
    `${manifest.session?.turns ?? '?'} 轮、$${manifest.session?.costUsd ?? '?'}。`,
    created.length === 0
      ? '没有在测试清单里建任务。'
      : `在测试清单里建了 ${created.length} 条任务（${created.map((e) => e.id).join('、')}）。`,
  ];
  if (cleanup.foreign?.length) {
    parts.push(`清场停止：清单里有 ${cleanup.foreign.length} 条非本 run 创建的任务，未删除。`);
  } else {
    parts.push(`清场删掉 ${cleanup.deleted?.length ?? 0} 条。`);
  }
  return parts.join('');
}
