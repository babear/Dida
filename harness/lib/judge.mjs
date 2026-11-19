import fs from 'node:fs';
import path from 'node:path';

import { buildSessionArgv, parseTranscript, runSession, sanitizeEnv, sessionCompleted } from './session.mjs';
import { JUDGE_SANDBOX, sandboxDirOf } from './sandbox.mjs';

export const JUDGE_AGENT_NAME = 'dida-judge';

// 判定 agent 只读文件，成本是一次短会话；给足读取时间又远短于被测会话的 15 分钟。
const JUDGE_TIMEOUT_MS = 5 * 60 * 1000;

// 三个维度是固定表：报告按它逐节渲染，缺一节就算判定缺失（AC：覆盖三个维度）。
export const DIMENSIONS = [
  { key: 'detour', label: '绕路' },
  { key: 'redundant', label: '冗余操作' },
  { key: 'read-before-write', label: '先读后改' },
];

export function buildJudgePrompt({ scenario, prompt, digestPath, created = [] }) {
  const tasks = created.length === 0
    ? '（没有建出任务）'
    : created.map((entry) => `- \`${entry.id}\` ${entry.title ?? '（无标题）'}`).join('\n');
  return [
    '你在读一次 skill 评测会话的记录，给这次会话写质量评价。只读，不要改任何文件。',
    '',
    '用户原话：',
    prompt,
    '',
    `会话摘要（每次工具调用一行，含它的结果片段；dida 调用另附 shim 记下的 argv）：${digestPath}`,
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

// 摘要只留判断三个维度要用的东西：谁在什么时候调了什么、结果长什么样。
// 原始轨迹里那 1994 条事件全塞进去，等于让判定 agent 自己去翻——实测 40 轮、$0.32。
// 每条结果截断到 RESULT_CHARS：一份长文件输出足以把整份摘要撑成另一份轨迹。
const RESULT_CHARS = 600;
const INPUT_CHARS = 400;

function clip(text, limit) {
  const value = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}…（截断，共 ${value.length} 字）` : value;
}

// 摘要会进另一个模型会话，凭据不该跟着走：`dida auth status` 的输出里就有 token。
// 只留前缀，够判「已登录」这件事，不够拿来用。
const SECRET = /(\b(?:token|secret|password|api[_-]?key)\b\s*[:=]\s*"?)([^\s"',]{6})([^\s"',]*)/gi;

export function redactSecrets(text) {
  return text.replace(SECRET, (_, prefix, head, rest) => `${prefix}${head}…（已脱敏，原 ${head.length + rest.length} 字）`);
}

// 工具调用的一行：名字 + 关键入参。只列有用字段，不把整个 input 倒出来。
function callLine(block) {
  const input = block.input ?? {};
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.skill ?? input.path ?? JSON.stringify(input);
  return `- [${block.name}] ${clip(detail, INPUT_CHARS)}`;
}

function resultText(block) {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
  }
  return '';
}

// 一段会话的摘要是给人（judge）读的叙述，不是可解析的数据结构：它只进 prompt 指向的文件。
// calls 是 shim 记的真 argv，与轨迹里的命令字符串各有各的用途——后者是 agent 怎么写的，
// 前者是实际执行了什么。
export function buildDigest({ events = [], calls = [] }) {
  const results = new Map();
  for (const event of events) {
    if (event.type !== 'user') continue;
    for (const block of event.message?.content ?? []) {
      if (block?.type === 'tool_result' && block.tool_use_id) {
        results.set(block.tool_use_id, resultText(block));
      }
    }
  }

  const lines = [];
  let index = 0;
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    for (const block of event.message?.content ?? []) {
      if (block?.type !== 'tool_use') continue;
      index += 1;
      lines.push(`### ${index}. ${block.name}`);
      lines.push(callLine(block).slice(2));
      const outcome = results.get(block.id);
      if (outcome) lines.push(`结果：${redactSecrets(clip(outcome, RESULT_CHARS))}`);
      lines.push('');
    }
  }

  if (calls.length > 0) {
    lines.push('## dida 调用（shim 记录的真实 argv）', '');
    for (const call of calls) {
      const decision = call.decision && call.decision !== 'allowed' ? `（${call.decision}${call.reason ? `：${call.reason}` : ''}）` : '';
      lines.push(`- \`dida ${(call.argv ?? []).join(' ')}\`${decision}`);
    }
  }
  return lines.join('\n').trimEnd();
}

// 判定 agent 的沙箱：与 scenario/ 并列的 judge/。cwd 里只有一份摘要，
// skill 副本、materials、shim 都不在这里——judge 评的是会话，不是去读被测的那份 skill。
// config 里只留 ANTHROPIC_* 键：与被测会话同一个模型与凭据，跨运行才可比。
// 路径规则复用 sandboxDirOf：两个沙箱必须落在同一个运行目录下，别各写一份。
export function createJudgeSandbox({ runId, anthropicEnv, digest }) {
  const root = sandboxDirOf(runId, JUDGE_SANDBOX);
  const workDir = path.join(root, 'work');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ env: anthropicEnv }, null, 2));
  const digestPath = path.join(workDir, 'digest.md');
  fs.writeFileSync(digestPath, `${digest}\n`);
  return { root, workDir, configDir, digestPath };
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
export async function judgeRun({ prompt, agentsPath, transcriptPath, workDir, configDir, runSessionFn = runSession }) {
  let session;
  try {
    session = await runSessionFn({
      argv: buildSessionArgv({ prompt, agentsPath, agentName: JUDGE_AGENT_NAME }),
      // cwd 是判定 agent 自己的沙箱 work/，里面只有摘要（见 createJudgeSandbox）。
      // 不以运行目录或仓库为 cwd：那两个位置带着 skill 副本、materials 与原始轨迹，
      // 都是噪音，会把评价往 skill 的措辞上带。
      cwd: workDir,
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
