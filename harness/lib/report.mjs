import { sessionCompleted } from './session.mjs';

// 首行只放前 12 位：够区分一次改动，又不至于长得没法读。
function short(value) {
  return value ? value.slice(0, 12) : 'unknown';
}

// 首行只写 CLI 自报的别名。ADR-0008：四条别名可能同指一个中转站模型，
// 把其中一条写成「实际模型」是误导；真实映射见报告正文的「模型」小节。
function modelLine(model) {
  return model?.requested_alias ?? 'unknown';
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

// 期望值与实际值可能是对象（`{kind: 'TEXT'}`），直接拼进字符串会变成 [object Object]，
// 而这条报告的全部意义就是让人一眼看出差在哪。控制台输出也走这一个，两处口径一致。
// 序列化会失败的值（循环引用、BigInt）折成一句人话：这是报告里的一行字，不该让整次运行崩掉。
export function formatValue(value) {
  if (value === undefined) return '（未给出）';
  if (value === '') return '（空）';
  if (typeof value !== 'string') {
    try {
      return JSON.stringify(value);
    } catch {
      return `（无法序列化：${typeof value}）`;
    }
  }
  return value;
}

export function renderAssertions(results) {
  return results
    .filter((result) => !result.ok)
    .map((result) => `- ${result.name}：期望 ${formatValue(result.expected)}，实际 ${formatValue(result.actual)}`)
    .join('\n');
}

const VERDICT_HEADING = '## 判定';

// broken 与 invalid 的报告形状一样：一句标题、一句原因、可选的失败项明细。
// 区别只在措辞指向「改用例」还是「查原因」。
function detailBlock(title, detail, results) {
  const lines = [VERDICT_HEADING, '', `**${title}**`, '', detail];
  if (results?.length) lines.push('', renderAssertions(results));
  return lines.join('\n');
}

// 可信度失败时断言照样跑了，结论存在 evaluated 里。它不影响 status，但是读者
// 判断「要不要重跑」的关键证据——一次真实的 skill 回归不该被一句「疑似绕过」盖掉。
// interrupted：会话没正常结束，快照取的是终止那一刻的清单，任务可能建了一半。
function evaluatedBlock(evaluated, { interrupted = false } = {}) {
  if (!evaluated) return [];
  const lines = ['', '### 同一份终态的结局断言（不影响上面的结论）', ''];
  if (evaluated.status === 'failed') {
    lines.push('**断言未通过**', '', renderAssertions(evaluated.results ?? []));
    // 只有失败才提示：通过时不需要解释为什么它可能不准。
    if (interrupted) lines.push('', '会话在此终止，清单可能停在半路——失败未必是 skill 没做到。');
  } else if (evaluated.status === 'passed') {
    lines.push('结局断言通过。');
  } else if (evaluated.status === 'broken') {
    lines.push(`用例配置错误：${evaluated.detail ?? '断言模块没给出结果数组'}`);
  } else if (evaluated.status === 'invalid') {
    // 快照取不到：这时断言模块没跑，evaluated 里只有快照那一类结论。
    lines.push(`取不到终态快照，评不了：${evaluated.detail ?? '未知原因'}`);
  }
  return lines;
}

// invalid 有三种原因，性质不同：快照取不到是基础设施故障（重跑大概率能好），
// 可信度失败是防护缺陷或 agent 行为（重跑不一定有用），无从判定则连结论都没有。
// 标题要能分开——判不出结论时不能说「可能绕过了」，那是在断言一个没观测到的事实。
// 报告标题与控制台短标签同表：加一个 cause 只改这一处。
const INVALID_CAUSES = {
  'cross-check': { title: '本次结果不可信：调用日志与轨迹对不上', label: '结果不可信' },
  indeterminate: { title: '本次结果不可用：轨迹读不出，无从比对', label: '无从判定' },
  state: { title: '本次结果不可用：终态快照取不到', label: '结果不可用' },
};

const FALLBACK_CAUSE = { title: '本次结果不可用', label: '结果不可用' };

export function invalidTitle(cause) {
  return (INVALID_CAUSES[cause] ?? FALLBACK_CAUSE).title;
}

export function invalidLabel(cause) {
  return (INVALID_CAUSES[cause] ?? FALLBACK_CAUSE).label;
}

export function renderVerdict({ assertion, session }) {
  const lines = [VERDICT_HEADING, ''];
  if (assertion?.status === 'missing') {
    lines.push('**用例配置错误：缺断言**', '');
    lines.push('`scenarios/<id>/` 里没有 `assert.mjs`，本次没有开会话。补上断言，或把用例移到 `probes/`。');
    return lines.join('\n');
  }
  if (assertion?.status === 'broken') {
    // 用例自己的问题：断言模块坏了、没给出结果数组。修用例，不用改 skill。
    return detailBlock('用例配置错误：断言没给出结果', assertion.detail ?? '断言模块没能给出结果数组。', assertion.results);
  }
  if (assertion?.status === 'invalid') {
    // 结果不可用，不当作 skill 缺陷（ADR-0012）。旧 manifest 没有 cause，退回通用标题。
    const title = invalidTitle(assertion.cause);
    return [detailBlock(title, assertion.detail ?? '', assertion.results), ...evaluatedBlock(assertion.evaluated)].join('\n');
  }
  if (!sessionCompleted(session ?? {})) {
    // 不能写「不评断言」——快照取到时确实评了，结论就在下面。
    const head = `${VERDICT_HEADING}\n\n会话未正常结束，不据此判定成败（见「会话」小节的退出码）。`;
    // 快照取到了就仍有一份结局结论：它不影响 status，但能看出 skill 本身有没有做到。
    return [head, ...evaluatedBlock(assertion?.evaluated, { interrupted: true })].join('\n');
  }
  if (assertion?.status === 'failed') {
    lines.push('**结局断言 未通过**', '', renderAssertions(assertion.results ?? []));
    return lines.join('\n');
  }
  // 只有明确的 passed 才写通过：旧 manifest（--clean 会重渲染）没有 assertion 字段，
  // 落到这里写「通过」等于给一次没评过的运行发绿灯。
  if (assertion?.status === 'passed') {
    lines.push('结局断言 通过');
    return lines.join('\n');
  }
  lines.push('未评断言（这份 manifest 没有断言结果，可能是旧版本运行）');
  return lines.join('\n');
}

export function renderReport(manifest) {
  const created = manifest.created ?? [];
  const cleanup = manifest.cleanup ?? { deleted: [], failed: [], remaining: [], mismatched: [] };
  // 只按「有没有开会话」短路，不按 broken：断言模块坏掉时会话照常跑完了，
  // 任务也建了、也清了——那种运行恰恰最需要看清单与清场结果。
  // writeUnusableRun 写的 manifest 没有 session 记录，是真正的「没跑起来」。
  const ranSession = manifest.session && Object.keys(manifest.session).length > 0;
  if (!ranSession) {
    return [
      `# ${manifest.scenario} · ${manifest.run}`,
      '',
      renderVerdict({ assertion: manifest.assertion, session: {} }),
    ].join('\n');
  }
  // 首行就是三个事实，人打开报告第一眼就能回答"测的是哪份 skill、哪个模型、沙箱在哪"。
  const lines = [
    renderHeader(manifest),
    `# ${manifest.scenario} · ${manifest.run}`,
    '',
    '## 本次创建的任务',
    '',
    created.length === 0 ? '（没有创建任何任务）' : taskTable(created),
    '',
    renderVerdict({ assertion: manifest.assertion, session: manifest.session }),
    '',
    '## 清场',
    '',
  ];

  if (cleanup.error) {
    lines.push(`**清场未执行**：${cleanup.error}`);
  } else if (cleanup.deferred) {
    lines.push(`未清场：会话未正常结束，现场保留。确认后用 \`--clean ${manifest.run}\` 收尾。`);
  } else {
    lines.push(`按账本删除 ${cleanup.deleted?.length ?? 0} 条，失败 ${cleanup.failed?.length ?? 0} 条。`);
    if (cleanup.remaining?.length) {
      lines.push('', `**删除后仍在清单里**：${cleanup.remaining.join('、')}`);
    }
    if (cleanup.mismatched?.length) {
      lines.push(
        '',
        '**账本与实况的清单不一致**（已按实际清单删除）：',
        '',
        ...cleanup.mismatched.map((e) => `- \`${e.id}\`：账本记在 ${e.recordedAt}，实际在 ${e.actual}`),
      );
    }
  }

  lines.push('', '## 会话', '');
  lines.push(`- 退出码 ${manifest.session?.exitCode ?? 'unknown'}${manifest.session?.timedOut ? '（超时）' : ''}`);
  lines.push(`- ${manifest.session?.turns ?? '?'} 轮，$${cost(manifest.session?.costUsd)}`);
  lines.push(`- 调用日志 ${manifest.calls?.path ?? '-'}（${manifest.calls?.total ?? 0} 条）`);
  if (manifest.calls?.rejected) {
    const outOfBounds = manifest.calls.outOfBounds ?? 0;
    const other = manifest.calls.rejected - outOfBounds;
    const parts = [];
    if (outOfBounds) parts.push(`越界写入 ${outOfBounds} 次`);
    if (other) parts.push(`解析不出目标 ${other} 次`);
    lines.push(`- 被拒绝的写命令 ${manifest.calls.rejected} 次（${parts.join('、')}；写请求没有发出去）`);
  }
  const cross = manifest.calls?.crossCheck;
  if (cross) {
    // 三态：判不出结论时不能说「对得上」，那是把「不知道」当成「没问题」。
    // 旧 manifest 只有 consistent 布尔（那时还没有「判不出」这个概念），按它回退。
    const status = cross.status ?? (cross.consistent ? 'consistent' : 'inconsistent');
    const line = {
      consistent: `- 与轨迹对得上：${cross.calls} 条 dida 调用 / ${cross.shapeCalls} 次 PowerShell`,
      inconsistent: `- **与轨迹对不上**：${cross.calls} 条 dida 调用 / ${cross.shapeCalls} 次 PowerShell；条数不等不等于有调用没被记录，多出来的可能是文件操作`,
      indeterminate: '- **无法比对**：轨迹里没有可解析的事件，判断不了调用是否都被记录',
    }[status];
    if (line) lines.push(line);
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
  const cleanup = manifest.cleanup ?? { deleted: [], failed: [], remaining: [], mismatched: [] };
  const skill = short(manifest.skill?.sha256);
  const parts = [
    `scenario ${manifest.scenario} 用 skill ${skill} 跑了一次真实会话，`,
    `${manifest.session?.turns ?? '?'} 轮、$${cost(manifest.session?.costUsd)}。`,
    created.length === 0
      ? '没有在测试清单里建任务。'
      : `在测试清单里建了 ${created.length} 条任务（${created.map((e) => e.id).join('、')}）。`,
  ];
  if (cleanup.deferred) {
    parts.push('会话未正常结束，任务与沙箱一并保留，需显式清场。');
  } else if (cleanup.error) {
    parts.push(`清场未执行：${cleanup.error}`);
  } else {
    parts.push(`清场删掉 ${cleanup.deleted?.length ?? 0} 条。`);
    if (cleanup.remaining?.length) parts.push(`有 ${cleanup.remaining.length} 条删完仍在清单里。`);
  }
  if (manifest.calls?.rejected) {
    const outOfBounds = manifest.calls.outOfBounds ?? 0;
    const other = manifest.calls.rejected - outOfBounds;
    const detail = [outOfBounds && `${outOfBounds} 次越界写入`, other && `${other} 次解析不出目标`]
      .filter(Boolean)
      .join('、');
    parts.push(`另有 ${manifest.calls.rejected} 次写命令被当场拒绝（${detail}）。`);
  }
  return parts.join('');
}
