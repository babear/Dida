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

// 探针没有判定（ADR-0015）：标题换成「取样」，因为它的结论只说明
// 「这份样本取到了」。沿用「判定」会让人以为 skill 被评过。
const SAMPLE_HEADING = '## 取样';

function headingFor(kind) {
  return kind === 'probe' ? SAMPLE_HEADING : VERDICT_HEADING;
}

// 标题行必须自报身份：探针与正式用例的产出原本完全同构，
// 不看 manifest 根本分不出这份报告是哪条路径跑的。
export function runTitle(manifest) {
  const label = manifest.kind === 'probe' ? '探针' : 'scenario';
  return `# ${label} ${manifest.scenario} · ${manifest.run}`;
}

// broken 与 invalid 的报告形状一样：一句标题、一句原因、可选的失败项明细。
// 区别只在措辞指向「改用例」还是「查原因」。
function detailBlock(title, detail, results, heading = VERDICT_HEADING) {
  const lines = [heading, '', `**${title}**`, '', detail];
  if (results?.length) lines.push('', renderAssertions(results));
  return lines.join('\n');
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

// 前置门（ADR-0014）：会话没正常结束时判定链没开始，不取快照、不跑断言。
// 措辞要与控制台的 INCOMPLETE 一致，不出现「跳过」——跳过会让人问「跳过什么、谁跳过谁」。
// 报告与控制台都从这里取，ADR-0014 要的是三处同一个词，那就只能有一处写它。
const INCOMPLETE_HEADLINE = '**会话没正常结束，判定链未开始**';
export const INCOMPLETE_FACT = '没有取终态快照，也没有跑任何断言';

function incompleteBlock(heading = VERDICT_HEADING) {
  return [
    heading, '', INCOMPLETE_HEADLINE, '', `${INCOMPLETE_FACT}：这次会话没有产出可判的事实（见「会话」小节的退出码）。`,
  ].join('\n');
}

const INCOMPLETE_BLOCK = incompleteBlock();

// 清场门控（ADR-0014）：只有 PASSED 才清场，其余一律保留现场。报告与控制台
// 共用这一句——两处各写一份，改一处就会漏另一处。
export function retentionNote(run) {
  return `现场已保留，用 \`--clean ${run}\` 收尾`;
}

// 为什么不给这条运行清场。理由取自判定结论，不取自会话退出码：
// 一次 invalid 的会话可能正常结束，按退出码写会说成「会话没跑完」。
// passed 也在这里：--hold 让通过的运行保留现场，那不是「没通过」。
// skipped 是旧 manifest 里 incomplete 的旧名，按同一件事写（与 renderVerdict 同口径）。
const RETENTION_REASONS = {
  passed: '操作者要求保留现场（--hold）',
  incomplete: '会话没正常结束，agent 可能只干到一半',
  skipped: '会话没正常结束，agent 可能只干到一半',
  invalid: '结果不可用，账本可能盖不住绕过 shim 建的任务，留现场比清一半好查',
  failed: '断言未通过，要能对着任务清单看它为什么失败',
  broken: '用例有缺陷，任务已建，现场要留着核对',
};

const FALLBACK_RETENTION_REASON = '没有自动清场';

export function retentionReason(status) {
  return RETENTION_REASONS[status] ?? FALLBACK_RETENTION_REASON;
}

// 为什么没清场。探针的保留理由与判定结论无关——它无论结论如何都不清场（ADR-0015），
// 所以这一句不能从 status 取，否则会写成「断言未通过」这种探针根本不成立的解释。
export function retentionCause(manifest) {
  return manifest.kind === 'probe'
    ? '探针保留现场供人查看与写断言'
    : retentionReason(manifest.assertion?.status);
}

export function renderVerdict({ assertion, kind, run }) {
  const heading = headingFor(kind);
  const lines = [heading, ''];
  // 预设失败发生在建运行目录之前（#19）：这次 run 根本没进入会话，判定链无从开始。
  // 与「缺断言」并列成一类用法错误——修 preset.mjs，不是改 skill。
  // 收尾那一句与保留现场共用 retentionNote，两处措辞同源。
  if (assertion?.status === 'preset-failed') {
    lines.push('**预设失败：本次没有进入会话**', '');
    lines.push(assertion.detail ?? 'preset.mjs 没能执行完。');
    lines.push(
      '',
      `若已建出任务，它们记在本 run 的 \`created.ndjson\` 里，${retentionNote(run)}。`,
      '修好 `preset.mjs` 再跑；它只造数据结构，目标必须 ∈ 本次清单集合。',
    );
    return lines.join('\n');
  }
  if (assertion?.status === 'missing') {
    lines.push('**用例配置错误：缺断言**', '');
    lines.push('`scenarios/<id>/` 里没有 `assert.mjs`，本次没有开会话。补上断言，或把用例移到 `probes/`。');
    return lines.join('\n');
  }
  if (assertion?.status === 'broken') {
    // broken 有两个来源，修的地方相反：断言模块坏掉是改用例，过程规则坏掉是改 harness。
    // 同一句「断言没给出结果」会把修 harness 的人引去改 assert.mjs。
    // 探针不会走到这里（它不跑断言），但旧 manifest 或接错线时仍要能渲染。
    if (assertion.surface === 'process') {
      return detailBlock(
        'harness 缺陷：过程断言规则没给出结果',
        assertion.detail ?? '过程断言规则抛了异常或返回了非法形状。',
        assertion.results,
        heading,
      );
    }
    return detailBlock(
      '用例配置错误：断言没给出结果',
      `${assertion.detail ?? '断言模块没能给出结果数组。'}\n\n去改 \`scenarios/<id>/assert.mjs\`，不是改 skill。`,
      assertion.results,
      heading,
    );
  }
  // 探针的成功词是 sampled（ADR-0015）：它只证明样本取到了，不证明 skill 对。
  // 放在 incomplete / invalid 之前，因为它的分支措辞与后面的判定口径完全不同。
  if (kind === 'probe' && assertion?.status === 'sampled') {
    return [
      heading, '',
      '**已取样**', '',
      '会话正常结束、可信度检查通过，终态快照已落盘。本次没有做任何判定——探针不跑断言。',
    ].join('\n');
  }
  // 前置门先于三面：会话没正常结束时判定链没开始，后面几面都没有结论可写。
  // 只按 status 判，不按 session 退出码：旧 manifest 里「会话没跑完」落的是 skipped，
  // 按同一件事渲染；而旧 manifest 里可信度失败落的是 invalid，退出码同样非零——
  // 那次的快照取了、断言也跑了，按前置门写会说出一件没发生过的事。
  if (assertion?.status === 'incomplete' || assertion?.status === 'skipped') return incompleteBlock(heading);
  if (assertion?.status === 'invalid') {
    // 结果不可用，不当作 skill 缺陷（ADR-0012）。旧 manifest 没有 cause，退回通用标题。
    // 判定链在这一面就停了：只写这一面，不并排任何后面的结论（ADR-0014）。
    return detailBlock(invalidTitle(assertion.cause), assertion.detail ?? '', assertion.results, heading);
  }
  if (assertion?.status === 'failed') {
    // 第三面（ADR-0005）与第二面都判 failed，含义相反：结局失败是「没做到」，
    // 过程失败是「做到了，但绕了远路」。两句话分开写，指引才不会指错。
    // 过程断言的失败项在 process.results 里，results 只放结局断言那几条。
    const process = assertion.surface === 'process';
    lines.push(process ? '**过程断言 未通过：做到了，但绕了远路**' : '**结局断言 未通过：skill 没做到**');
    lines.push('', renderAssertions(process ? (assertion.process?.results ?? []) : (assertion.results ?? [])));
    lines.push('', '去改 skill。同样的 skill 再跑一次不会变绿。');
    return lines.join('\n');
  }
  // 只有明确的 passed 才写通过：旧 manifest（--clean 会重渲染）没有 assertion 字段，
  // 落到这里写「通过」等于给一次没评过的运行发绿灯。
  if (assertion?.status === 'passed') {
    lines.push('结局断言 通过');
    // 过程那一面有三种状态，不能混：没写 process.mjs（未判）/ 跑了全过（通过）/
    // 旧 manifest 没有这个字段（不写）。「未判」写成「通过」是把没做的事说成做了。
    if (assertion.process?.evaluated === true) {
      const count = assertion.process.results?.length ?? 0;
      lines.push(`过程断言 通过（${count} 条）`);
    } else if (assertion.process?.evaluated === false) {
      lines.push('过程断言 未判（这条用例没有 `process.mjs`）');
    }
    return lines.join('\n');
  }
  lines.push('未评断言（这份 manifest 没有断言结果，可能是旧版本运行）');
  return lines.join('\n');
}

// 被拒写命令的原因要分开说：四类归因不同，处置也不同（改 agent 命令 / 改 scenario / 改 guard）。
// 合成「越界」与「其它」两桶会把 guard 没覆盖哪条命令这件事藏起来。
// 旧 manifest 没有 rejectedReasons，退回按两个总数渲染。
const REJECT_LABELS = {
  'out-of-bounds': '越界写入',
  'unknown-command': '未知命令',
  'id-mismatch': 'id 不一致',
  'no-target': '解析不出目标',
};

export function rejectedSummary(calls) {
  const reasons = calls?.rejectedReasons;
  if (reasons) {
    return Object.entries(reasons)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${REJECT_LABELS[reason] ?? reason} ${count} 次`);
  }
  const outOfBounds = calls?.outOfBounds ?? 0;
  const other = (calls?.rejected ?? 0) - outOfBounds;
  return [
    outOfBounds && `越界写入 ${outOfBounds} 次`,
    other > 0 && `解析不出目标 ${other} 次`,
  ].filter(Boolean);
}

// 重试的说明行（#9）。重试的是**一次新的运行**——新 runId、新账本、新会话——
// 所以它不是「上一页的续写」，而是这一页自己声明「我是第 2 次」。
// 首次的结论与被顶替的 run 都要点名：只写「第 2 次」的话，人看不出第一次红过，
// 重试就从「说明一次抖动」变成了「掩盖一次失败」。
function retryNote(manifest) {
  const retry = manifest.retry;
  if (!retry) return null;
  return `第 ${retry.attempt} 次运行：首次（\`${retry.previousRun}\`）结论为 ${retry.previousStatus}，`
    + '不重试的那几类结论会直接判红。这次是重试后的结果。';
}

export function renderReport(manifest) {
  const created = manifest.created ?? [];
  const cleanup = manifest.cleanup ?? { deleted: [], failed: [], remaining: [], mismatched: [] };
  // 只按「有没有开会话」短路，不按 broken：断言模块坏掉时会话照常跑完了，
  // 任务也建了、也清了——那种运行恰恰最需要看清单与清场结果。
  // writeUnusableRun 写的 manifest 没有 session 记录，是真正的「没跑起来」。
  // 预设失败同样没开会话，但它**已经建出任务**：账本要看得见，--clean 才有着落（#19）。
  const ranSession = manifest.session && Object.keys(manifest.session).length > 0;
  if (!ranSession && manifest.assertion?.status !== 'preset-failed') {
    return [
      runTitle(manifest),
      '',
      renderVerdict({ assertion: manifest.assertion, kind: manifest.kind, run: manifest.run }),
    ].join('\n');
  }
  if (!ranSession) {
    return [
      runTitle(manifest),
      '',
      '## 预设建出的任务',
      '',
      created.length === 0 ? '（一条都没有建出来）' : taskTable(created),
      '',
      renderVerdict({ assertion: manifest.assertion, kind: manifest.kind, run: manifest.run }),
    ].join('\n');
  }
  // 首行就是三个事实，人打开报告第一眼就能回答"测的是哪份 skill、哪个模型、运行目录在哪"。
  const lines = [
    renderHeader(manifest),
    runTitle(manifest),
    '',
  ];
  // 重试的说明紧跟标题：它是读这份报告前就该知道的前提，不是末尾的附注。
  const retry = retryNote(manifest);
  if (retry) lines.push(`> ${retry}`, '');
  lines.push(
    '## 本次创建的任务',
    '',
    created.length === 0 ? '（没有创建任何任务）' : taskTable(created),
    '',
    renderVerdict({ assertion: manifest.assertion, kind: manifest.kind, run: manifest.run }),
    '',
    '## 清场',
    '',
  );

  if (cleanup.error) {
    lines.push(`**清场未执行**：${cleanup.error}`);
  } else if (cleanup.deferred) {
    lines.push(`未清场：${retentionCause(manifest)}。${retentionNote(manifest.run)}。`);
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

  // 探针目录里的 assert.mjs 不执行（ADR-0012）。控制台与报告各留一行——
  // 只在控制台说一遍，读报告的人会对着「没有结论」自己猜原因。
  if (manifest.unusedAssert) {
    lines.push('', `> 本目录的 \`assert.mjs\` 未被使用——断言只在 \`scenarios/\` 生效。`);
  }

  lines.push('', '## 会话', '');
  lines.push(`- 退出码 ${manifest.session?.exitCode ?? 'unknown'}${manifest.session?.timedOut ? '（超时）' : ''}`);
  lines.push(`- ${manifest.session?.turns ?? '?'} 轮，$${cost(manifest.session?.costUsd)}`);
  lines.push(`- 调用日志 ${manifest.calls?.path ?? '-'}（${manifest.calls?.total ?? 0} 条）`);
  // 判据点名了哪几次调用没对上之后，读者需要轨迹才能自己核对（#18 移交的第 3 条）。
  if (manifest.transcript?.path) {
    lines.push(`- 轨迹 ${manifest.transcript.path}（${manifest.transcript.events ?? 0} 条事件，${manifest.transcript.toolCalls ?? 0} 次工具调用）`);
  }
  if (manifest.calls?.rejected) {
    lines.push(`- 被拒绝的写命令 ${manifest.calls.rejected} 次（${rejectedSummary(manifest.calls).join('、')}；写请求没有发出去）`);
  }
  const cross = manifest.calls?.crossCheck;
  // 会话没正常结束时判定链没开始，可信度检查没跑过（ADR-0014）：这时候把
  // 「与轨迹对不上」写进报告，等于在 INCOMPLETE 旁边多摆一组结论，又回到那个形状。
  const judged = manifest.assertion?.status !== 'incomplete' && manifest.assertion?.status !== 'skipped';
  if (cross && judged) {
    // 三态：判不出结论时不能说「对得上」，那是把「不知道」当成「没问题」。
    // 判据是逐调用比对（#18），detail 里点出是哪几次调用没对上、以及为什么判不了。
    // 旧 manifest 只有 consistent 布尔（那时还没有「判不出」这个概念），按它回退。
    const status = cross.status ?? (cross.consistent ? 'consistent' : 'inconsistent');
    const why = cross.detail ? `：${cross.detail}` : '';
    const line = {
      consistent: '- 与轨迹对得上：轨迹里的 dida 调用在日志里都有对应',
      inconsistent: `- **与轨迹对不上**${why}；这几次调用没走过 shim，轨迹里找得到、日志里没有`,
      indeterminate: `- **无法比对**${why}`,
    }[status];
    if (line) lines.push(line);
  }
  lines.push(`- 运行目录${manifest.sandboxRetained === false ? '已删除' : '保留'}：${manifest.sandbox}`);

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
  const isProbe = manifest.kind === 'probe';
  const parts = [
    `${isProbe ? '探针' : 'scenario'} ${manifest.scenario} 用 skill ${skill} 跑了一次真实会话，`,
    `${manifest.session?.turns ?? '?'} 轮、$${cost(manifest.session?.costUsd)}。`,
    created.length === 0
      ? '没有在测试清单里建任务。'
      : `在测试清单里建了 ${created.length} 条任务（${created.map((e) => e.id).join('、')}）。`,
  ];
  if (cleanup.deferred) {
    parts.push(`${retentionCause(manifest)}，任务与运行目录一并保留（${retentionNote(manifest.run)}）。`);
  } else if (cleanup.error) {
    parts.push(`清场未执行：${cleanup.error}`);
  } else {
    parts.push(`清场删掉 ${cleanup.deleted?.length ?? 0} 条。`);
    if (cleanup.remaining?.length) parts.push(`有 ${cleanup.remaining.length} 条删完仍在清单里。`);
  }
  if (manifest.calls?.rejected) {
    parts.push(`另有 ${manifest.calls.rejected} 次写命令被当场拒绝（${rejectedSummary(manifest.calls).join('、')}）。`);
  }
  return parts.join('');
}
