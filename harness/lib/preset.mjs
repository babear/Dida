import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { recordCreated } from './created.mjs';
import { decide, parseArgv } from './guard.mjs';

// 预设的失败一律走这个类型：编排层据此判「这次 run 不进入会话」，
// 与断言模块坏了（BROKEN）分开——那个是会话跑完之后的事。
export class PresetError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'PresetError';
    this.reason = reason;
  }
}

// 有任务指针的命令。这张表**不能从 WRITE_COMMANDS 推**：那张表只声明清单目标，
// --parent-id 与 --tasks 都不在其中（只在 VALUE_FLAGS 里）。
// 位置参数按 0 基计，与 guard.mjs 的 positionalAt 一致。
// 只列**真的有指针**的命令：其余写命令由 decide 照常校验清单目标。
const TASK_POINTERS = {
  'task create': [{ flag: '--parent-id' }],
  'task update': [{ positional: 0 }, { flag: '--id' }, { flag: '--parent-id' }],
  'task move': [{ flag: '--task' }],
  'task complete': [{ positional: 1 }],
  'task delete': [{ positional: 1 }],
  'task comment add': [{ positional: 1 }],
  // 位置参数 1 是 taskId、2 是 commentId：两者都在账本之外，任一出就拒绝。
  'task comment delete': [{ positional: 1 }, { positional: 2 }],
  'task assign': [{ flag: '--task' }],
  'task unassign': [{ flag: '--task' }],
  'task complete-batch': [{ flag: '--tasks' }],
  // 子资源指针：不是任务，但同属账本之外的已有资源。
  'project column update': [{ positional: 1 }],
};

const COMMAND_PATHS = Object.keys(TASK_POINTERS).map((commandPath) => commandPath.split(' '));

// 认得出来的写命令路径，只用于把「不支持这类命令」的报错写准。
// 不参与判定：判定顺序见 checkOne。
const KNOWN_WRITE_PATHS = [
  ['task', 'create'], ['task', 'update'], ['task', 'move'], ['task', 'complete'],
  ['task', 'delete'], ['task', 'comment', 'add'], ['task', 'comment', 'delete'],
  ['task', 'assign'], ['task', 'unassign'], ['task', 'complete-batch'],
  ['project', 'create'], ['project', 'update'], ['project', 'delete'],
  ['project', 'group', 'create'], ['project', 'group', 'update'], ['project', 'group', 'delete'],
  ['project', 'column', 'create'], ['project', 'column', 'update'],
  ['habit', 'create'], ['habit', 'update'], ['habit', 'checkin'],
  ['focus', 'create'], ['focus', 'update'], ['focus', 'delete'],
  ['tag', 'create'], ['tag', 'update'], ['tag', 'rename'], ['tag', 'delete'],
  ['auth', 'login'], ['auth', 'logout'], ['auth', 'token'],
];

const maybeOption = (arg) => arg.length > 1 && arg[0] === '-';

// 命令路径取 argv 前若干段里能匹配上的最长一条（task comment add 比 task comment 长）。
// 与 guard.mjs 的 matchLongest 同一判据：跳过选项再逐段比。
function longestMatch(paths, argv) {
  const tokens = argv.filter((arg) => !maybeOption(arg));
  const match = paths
    .map((candidate) => ({ candidate, hits: candidate.every((part, i) => tokens[i] === part) }))
    .filter((entry) => entry.hits)
    .sort((a, b) => b.candidate.length - a.candidate.length)[0];
  return match ? match.candidate.join(' ') : null;
}

// 有任务指针的命令路径（用于 pointerOf 的查表）。
function commandPathOf(argv) {
  return longestMatch(COMMAND_PATHS, argv);
}

// 报错措辞用的命令名：先认写命令，认不出再退回指针表。
function writePathOf(argv) {
  return longestMatch(KNOWN_WRITE_PATHS, argv) ?? commandPathOf(argv);
}

function pointerOf(commandPath, parsed) {
  const pointers = TASK_POINTERS[commandPath] ?? [];
  const commandLength = commandPath.split(' ').length;
  for (const pointer of pointers) {
    if (pointer.flag && parsed.flags.has(pointer.flag)) return pointer.flag;
    if (pointer.positional !== undefined) {
      const value = parsed.positionals[commandLength + pointer.positional];
      if (value !== undefined) return `位置参数 ${pointer.positional}`;
    }
  }
  return null;
}

// 一条命令能不能出现在 preset 里。**顺序**是有意的：
//   1. 清单越界最先报：它是作者最常见也最容易修的错（写错了清单 id），
//      而越界的命令往往同时还带着任务指针，先报指针会把人引向错误的修法。
//   2. 再判任务指针。ADR-0012 的表，出现即拒绝。
//   3. 只允许 `task create`：**账本只记得下 task create 建出的 id**
//      （created.mjs 的 isCreateCall）。放行别的写命令等于让它改了真实数据
//      而清场看不见——`project delete <测试清单>` 会删掉整份清单且无从收尾。
//   4. decide 放行但 targets 为空（--help、裸命令组、只读命令）判 empty：
//      放行等于静默空跑，预设什么都没建却让用例照常跑下去。
//   5. 无目标写命令（project create 等）判 no-target 并说明不支持。
function checkOne(argv, projects) {
  const parsed = parseArgv(argv);
  const commandPath = commandPathOf(argv);
  const verdict = decide(argv, projects);

  if (!verdict.allow && verdict.reason === 'out-of-bounds') {
    return {
      reason: 'out-of-bounds',
      detail: `预设的目标清单不在本次清单集合内：${argv.join(' ')}。越界的是 ${verdict.targets.join('、')}`,
    };
  }

  if (commandPath) {
    const pointer = pointerOf(commandPath, parsed);
    if (pointer) {
      return { reason: 'task-pointer', detail: `预设不能指向已有任务：${commandPath} 的 ${pointer}` };
    }
  }

  if (verdict.allow) {
    if (verdict.targets.length === 0) {
      return {
        reason: 'empty',
        detail: `预设里的命令不产生任何写入：${argv.join(' ')}（--help、裸命令组与只读命令都不算造数据）`,
      };
    }
    // 只有 task create 的产物能被记账、被清场收回。其余写命令（project update /
    // project delete / column create …）decide 只看清单目标，拦得住越界却记不了账。
    if (commandPath !== 'task create') {
      return {
        reason: 'unsupported-command',
        detail: `预设只支持 task create，不支持 ${writePathOf(argv) ?? argv.join(' ')}：`
          + '账本只记得下 task create 建出的任务 id，别的写命令改了真实数据却清不回来。',
      };
    }
    return null;
  }

  if (verdict.reason === 'no-target') {
    return {
      reason: 'no-target',
      detail: `预设不支持无目标写命令：${argv.join(' ')}。建清单类的前置数据会突破测试清单集合的边界；`
        + '需要新清单时先手工建好，把它加进测试清单集合。',
    };
  }
  return { reason: verdict.reason, detail: `预设里的命令被拒绝（${verdict.reason}）：${argv.join(' ')}` };
}

// 在**执行之前**整体校验：一条越界都不跑，否则前几条已经建进真实清单，
// 报错时它们还没有账本记录之外的痕迹可循。
export function checkPreset(commands, projects) {
  if (!Array.isArray(commands)) {
    return { ok: false, reason: 'bad-shape', detail: 'preset.mjs 的默认导出要返回命令数组' };
  }
  if (commands.length === 0) {
    return { ok: false, reason: 'empty', detail: '预设是空的：它一条数据都不建，用例的前置数据不会存在' };
  }
  for (let index = 0; index < commands.length; index += 1) {
    const argv = commands[index];
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((token) => typeof token !== 'string')) {
      return {
        ok: false,
        reason: 'bad-shape',
        index,
        detail: `预设第 ${index + 1} 条不是字符串数组：${JSON.stringify(argv)}`,
      };
    }
    const failure = checkOne(argv, projects);
    if (failure) return { ok: false, index, ...failure };
  }
  return { ok: true };
}

// 加载模块。缺文件返回 null：没有 preset.mjs 的 scenario 行为不变。
// 其余失败一律抛——静默跳过会让「写了预设却没生效」变成一次无声的红。
export async function loadPreset(scenarioDir) {
  const file = path.join(scenarioDir, 'preset.mjs');
  if (!fs.existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.default !== 'function') {
    throw new PresetError(`${file} 没有默认导出的函数`, 'bad-shape');
  }
  return mod.default;
}

// 取 preset 声明的命令。清单是副本：它拿到的必须是本次 run 实际用的那一份，
// 但改不动 harness 手里的这份（后者的同一数组还要建沙箱、传清场）。
function declaredCommands(presetFn, projects) {
  let commands;
  try {
    commands = presetFn([...projects]);
  } catch (error) {
    throw new PresetError(`preset.mjs 执行抛异常：${error.message}`, 'threw');
  }
  const checked = checkPreset(commands, projects);
  if (!checked.ok) {
    const where = checked.index === undefined ? '' : `第 ${checked.index + 1} 条：`;
    throw new PresetError(`预设被拒绝（${checked.reason}）：${where}${checked.detail}`, checked.reason);
  }
  return commands;
}

// 执行顺序保证「建出的 id 立刻进账本」：每条命令转发后马上 recordCreated，
// 中途失败时已建的任务留在账本里，`--clean <runId>` 读得到、删得掉。
// 预设在建沙箱之前跑，用真 CLI——shim 是给被测 agent 用的。
// 加载也在这一处：模块坏掉（没有默认导出）与执行失败对编排层是同一件事——
// 这次 run 不进入会话、不清场。
export async function runPreset({ scenarioDir, dida, projects, createdFile }) {
  const presetFn = await loadPreset(scenarioDir);
  if (!presetFn) return;

  const commands = declaredCommands(presetFn, projects);

  for (let index = 0; index < commands.length; index += 1) {
    const argv = commands[index];
    const result = dida.run(argv);
    if (result.exitCode !== 0) {
      throw new PresetError(
        `预设第 ${index + 1} 条失败：${argv.join(' ')}。${(result.stderr ?? '').trim() || `exit ${result.exitCode}`}`,
        'exec-failed',
      );
    }
    // 没建出 id（输出里抠不到）不报错：记不上账就是清不掉，但预设本身跑成功了。
    // 真正需要报的是命令失败——那会让后面依赖它的命令一起错。
    recordCreated(createdFile, { argv, stdout: result.stdout, origin: 'preset' });
  }
}
