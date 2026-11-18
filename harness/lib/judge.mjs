import os from 'node:os';

import { buildSessionArgv, parseTranscript, runSession, sanitizeEnv, sessionCompleted } from './session.mjs';

export const JUDGE_AGENT_NAME = 'dida-judge';

// 判定 agent 只读文件，成本是一次短会话；给足读取时间又远短于被测会话的 15 分钟。
const JUDGE_TIMEOUT_MS = 5 * 60 * 1000;

// 三个维度是固定表：报告按它逐节渲染，缺一节就算判定缺失（AC：覆盖三个维度）。
export const DIMENSIONS = [
  { key: 'detour', label: '绕路' },
  { key: 'redundant', label: '冗余操作' },
  { key: 'read-before-write', label: '先读后改' },
];

export function buildJudgePrompt({ scenario, prompt, tracePath, callsPath, created = [] }) {
  const tasks = created.length === 0
    ? '（没有建出任务）'
    : created.map((entry) => `- \`${entry.id}\` ${entry.title ?? '（无标题）'}`).join('\n');
  return [
    '你在读一次 skill 评测会话的记录，给这次会话写质量评价。只读，不要改任何文件。',
    '',
    '用户原话：',
    prompt,
    '',
    `会话轨迹（stream-json NDJSON，每次工具调用的入参与结果）：${tracePath}`,
    `dida 调用日志（每行 {argv, at, decision}）：${callsPath}`,
    '本次建出的任务：',
    tasks,
    '',
    '按下面三个维度各写一节，三个标题必须逐字写成这三行：',
    ...DIMENSIONS.map((dimension) => `## ${dimension.label}`),
    '',
    '每节 2–5 句，指出具体是哪几次调用、为什么算问题。没有可说的就写「未观察到」。',
    '不要输出这三节之外的任何内容，不要给总分。',
    `这次评测的对象是 ${scenario}。`,
  ].join('\n');
}

// 按三个固定标题切段。只认标题逐字相同的行：判定 agent 换个说法就说明它没按约定作答，
// 那种输出不能冒充「覆盖了三个维度」。
export function parseJudgement(text) {
  const bodies = new Map();
  let current = null;
  for (const line of (text ?? '').split(/\r?\n/)) {
    const heading = DIMENSIONS.find((dimension) => line.trim() === `## ${dimension.label}`);
    if (heading) {
      current = heading.key;
      bodies.set(current, []);
      continue;
    }
    if (current) bodies.get(current).push(line);
  }
  const dimensions = [];
  const missingLabels = [];
  for (const dimension of DIMENSIONS) {
    const body = (bodies.get(dimension.key) ?? []).join('\n').trim();
    if (body) dimensions.push({ ...dimension, body });
    else missingLabels.push(dimension.label);
  }
  return { dimensions, missing: missingLabels };
}

function missing(reason) {
  return { status: 'missing', reason };
}

// 判定 agent 的结论从轨迹的 result 事件取；取不到时退回 assistant 文本块。
export function judgeTextOf(events) {
  const result = events.find((event) => event.type === 'result');
  if (typeof result?.result === 'string' && result.result.trim()) return result.result;
  const chunks = [];
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text' && block.text) chunks.push(block.text);
    }
  }
  return chunks.join('\n').trim() || null;
}

// 判定缺失的每一种来路都要说清是哪一种，读者才知道该重跑、该看输出，还是该查为什么没起来。
// 任何失败都折成 missing，绝不抛：它不参与判定，不该让一次已经跑完的会话丢结论。
// 判定 agent 用**运行目录里那份 settings**（与 configDir 一起传给会话模块），
// 与被测会话同一个模型与凭据：否则两次运行的质量评价可能来自不同模型，
// 而这一段的价值恰恰在于跨运行可比。
//
// cwd 取系统临时目录，不是运行目录也不是仓库：那两个位置会继承 CLAUDE.md 与那里的 skill，
// 而判定 agent 读的是会话记录，不是项目说明。
export async function judgeRun({ prompt, agentsPath, transcriptPath, runDir, configDir, runSessionFn = runSession }) {
  let session;
  try {
    session = await runSessionFn({
      argv: buildSessionArgv({
        prompt,
        agentsPath,
        agentName: JUDGE_AGENT_NAME,
        // 判定 agent 的 cwd 是系统临时目录，要读的 runs/<runId>/ 在它之外：
        // dontAsk 下不显式授权就会每次都被拒，落成「判定缺失」而看不出原因。
        addDirs: runDir ? [runDir] : [],
      }),
      cwd: os.tmpdir(),
      env: { ...sanitizeEnv(process.env), ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) },
      transcriptPath,
      timeoutMs: JUDGE_TIMEOUT_MS,
    });
  } catch (error) {
    return missing(`判定 agent 没能启动：${error.message}`);
  }
  if (!sessionCompleted(session)) {
    return missing(`判定 agent 没正常结束（退出码 ${session.exitCode}${session.timedOut ? '，超时' : ''}）`);
  }

  let events;
  try {
    events = parseTranscript(transcriptPath);
  } catch (error) {
    return missing(`判定 agent 的轨迹读不出来：${error.message}`);
  }
  const text = judgeTextOf(events);
  if (!text) return missing('判定 agent 没有给出结论文本');

  const parsed = parseJudgement(text);
  if (parsed.missing.length > 0) {
    return missing(`判定输出缺维度：${parsed.missing.join('、')}`);
  }
  return { status: 'ok', dimensions: parsed.dimensions };
}

// 人工复核条目从 scenario.json 的 review 读。形状写错时照常渲染一行说明，
// 不静默丢掉、也不让整次运行停下——它是给人看的清单，不是判定依据。
// 「缺哪些字段」只在这里算一次：渲染方照着写，不自己再推一遍。
// 人工复核条目从 scenario.json 的 review 读。形状写错时照常渲染一行说明，
// 不静默丢掉、也不让整次运行停下——它是给人看的清单，不是判定依据。
// 「缺哪些字段」只在这里算一次：渲染方照着写，不自己再推一遍。
// 条目的任务可以用 `id` 直接写，也可以只写 `title`，跑完由 resolveReview 对着账本解析。
export function reviewEntriesOf(review) {
  if (!Array.isArray(review)) return [];
  return review.map((entry) => {
    const title = typeof entry?.title === 'string' ? entry.title : null;
    const expect = typeof entry?.expect === 'string' ? entry.expect : null;
    const id = typeof entry?.id === 'string' && /^[0-9a-f]{24}$/.test(entry.id) ? entry.id : null;
    const missingFields = [
      title || id ? null : 'title',
      expect ? null : 'expect',
    ].filter(Boolean);
    return missingFields.length === 0 ? { title, id, expect } : { title, id, expect, missingFields };
  });
}

// 把条目里的描述对应到本次建出的任务上。按标题精确匹配；一条任务被两条条目认领时
// 各自都算——复核表是给人看的，不是断言，重复指到同一条任务没有坏处。
// 条目已经写了 id 就不动它。
export function resolveReview(review, created) {
  return review.map((entry) => {
    if (entry.id) return entry;
    const match = created.find((task) => task.title === entry.title);
    return match ? { ...entry, id: match.id } : { ...entry, unresolved: true };
  });
}
