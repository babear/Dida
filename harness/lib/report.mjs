// 首行只放前 12 位：够区分一次改动，又不至于长得没法读。
function short(value) {
  return value ? value.slice(0, 12) : 'unknown';
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
    `skill ${short(manifest.skill?.sha256)} @ ${short(manifest.skill?.git?.rev)}${dirty}`,
    `model ${modelLine(manifest.model)}`,
    `sandbox ${manifest.sandbox}`,
  ].join('  |  ');
}

function taskTable(entries) {
  const rows = entries
    .map((entry) => `| ${entry.id} | ${entry.projectId ?? '-'} | ${entry.title ?? '（无标题）'} |`)
    .join('\n');
  return ['| 任务 id | 清单 | 标题 |', '|---|---|---|', rows].join('\n');
}

function cost(costUsd) {
  return typeof costUsd === 'number' ? costUsd.toFixed(4) : '?';
}

export function renderReport(manifest) {
  const created = manifest.created ?? [];
  const cleanup = manifest.cleanup ?? { deleted: [], failed: [], foreign: [] };
  // 首行就是三个事实，人打开报告第一眼就能回答"测的是哪份 skill、哪个模型、沙箱在哪"。
  const lines = [
    renderHeader(manifest),
    `# ${manifest.scenario} · ${manifest.run}`,
    '',
    '## 本次创建的任务',
    '',
    created.length === 0 ? '（没有创建任何任务）' : taskTable(created),
    '',
    '## 清场',
    '',
  ];

  if (cleanup.foreign?.length) {
    lines.push(
      '**清场已停止**：清单里有非本 run 创建的任务，未记账因此不动手。',
      '',
      taskTable(cleanup.foreign),
    );
  } else if (cleanup.error) {
    lines.push(`**清场未执行**：${cleanup.error}`);
  } else if (cleanup.deferred) {
    lines.push(`未清场：会话未正常结束，现场保留。确认后用 \`--clean ${manifest.run}\` 收尾。`);
  } else {
    lines.push(`按 created.json 删除 ${cleanup.deleted?.length ?? 0} 条，失败 ${cleanup.failed?.length ?? 0} 条。`);
  }

  lines.push('', '## 会话', '');
  lines.push(`- 退出码 ${manifest.session?.exitCode ?? 'unknown'}${manifest.session?.timedOut ? '（超时）' : ''}`);
  lines.push(`- ${manifest.session?.turns ?? '?'} 轮，$${cost(manifest.session?.costUsd)}`);
  lines.push(`- 调用日志 ${manifest.calls?.path ?? '-'}（${manifest.calls?.total ?? 0} 条）`);
  const cross = manifest.calls?.crossCheck;
  if (cross) {
    lines.push(
      cross.consistent
        ? `- 与轨迹对得上：${cross.calls} 条 dida 调用 / ${cross.shapeCalls} 次 PowerShell`
        : `- **与轨迹对不上**：只有 ${cross.calls} 条 dida 调用，轨迹里却有 ${cross.shapeCalls} 次 PowerShell；可能有调用绕过了 shim`,
    );
  }
  lines.push(`- 沙箱${manifest.sandboxRetained === false ? '已删除' : '保留'}：${manifest.sandbox}`);

  lines.push('', '## 模型', '');
  lines.push('CLI 自报的是别名，不是实际执行的模型；真实模型看下面的映射。', '');
  lines.push(`- CLI 自报：\`${manifest.model?.requested_alias ?? 'unknown'}\``);
  lines.push(`- 代理地址：\`${manifest.model?.provider ?? 'unknown'}\``);
  lines.push('', '| 别名 | 映射到的模型 | 可读名 |', '|---|---|---|');
  for (const [alias, entry] of Object.entries(manifest.model?.alias_mapping ?? {})) {
    lines.push(`| ${alias} | \`${entry?.model ?? '未配置'}\` | ${entry?.name ?? '-'} |`);
  }

  lines.push('', '## 摘要', '', renderSummary(manifest));
  return lines.join('\n');
}

export function renderSummary(manifest) {
  const created = manifest.created ?? [];
  const cleanup = manifest.cleanup ?? { deleted: [], failed: [], foreign: [] };
  const skill = short(manifest.skill?.sha256);
  const parts = [
    `scenario ${manifest.scenario} 用 skill ${skill} 跑了一次真实会话，`,
    `${manifest.session?.turns ?? '?'} 轮、$${cost(manifest.session?.costUsd)}。`,
    created.length === 0
      ? '没有在测试清单里建任务。'
      : `在测试清单里建了 ${created.length} 条任务（${created.map((e) => e.id).join('、')}）。`,
  ];
  if (cleanup.foreign?.length) {
    parts.push(`清场停止：清单里有 ${cleanup.foreign.length} 条非本 run 创建的任务，未删除。`);
  } else if (cleanup.deferred) {
    parts.push('会话未正常结束，任务与沙箱一并保留，需显式清场。');
  } else {
    parts.push(`清场删掉 ${cleanup.deleted?.length ?? 0} 条。`);
  }
  return parts.join('');
}
