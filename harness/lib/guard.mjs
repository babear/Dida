// 越界写入防护：对写命令解析目标清单，解析不出或不在测试清单集合内就拒绝。
// 纯函数、零 IO —— shim 只负责调用与写盘，这里全部可单测。

// 目标清单从哪取。positional 是命令占掉位置参数之后剩下的序号
// （如 task complete <projectId> <taskId> 里 projectId 是 positionals[0]）。
const PROJECT_FLAG = [{ flag: '--project' }];

// 写命令表：命令路径 → 目标来源。没有目标的写命令显式记成 []，别让"表里没有"和"没目标"混在一起。
export const WRITE_COMMANDS = [
  [['task', 'create'], PROJECT_FLAG],
  [['task', 'update'], PROJECT_FLAG, { sameId: { flag: '--id', positional: 0 } }],
  [['task', 'move'], [{ flag: '--from' }, { flag: '--to' }]],
  [['task', 'complete'], [{ positional: 0 }]],
  [['task', 'delete'], [{ positional: 0 }]],
  [['task', 'comment', 'add'], [{ positional: 0 }]],
  [['task', 'comment', 'delete'], [{ positional: 0 }]],
  [['task', 'assign'], PROJECT_FLAG],
  [['task', 'unassign'], PROJECT_FLAG],
  [['task', 'complete-batch'], PROJECT_FLAG],

  [['project', 'update'], [{ positional: 0 }]],
  [['project', 'delete'], [{ positional: 0 }]],
  [['project', 'column', 'create'], [{ positional: 0 }]],
  [['project', 'column', 'update'], [{ positional: 0 }]],

  // 以下写命令不落在任何清单上；无法判定是否越界，一律拒绝。
  [['project', 'create'], []],
  [['project', 'group', 'create'], []],
  [['project', 'group', 'update'], []],
  [['project', 'group', 'delete'], []],
  [['habit', 'create'], []],
  [['habit', 'update'], []],
  [['habit', 'checkin'], []],
  [['focus', 'create'], []],
  [['focus', 'update'], []],
  [['focus', 'delete'], []],
  [['tag', 'create'], []],
  [['tag', 'update'], []],
  [['tag', 'rename'], []],
  [['tag', 'delete'], []],
  [['auth', 'login'], []],
  [['auth', 'logout'], []],
  [['auth', 'token'], []],
];

// 带值选项。参数解析要知道哪些 flag 会吃掉后一个 token，否则会把值当成位置参数。
const VALUE_FLAGS = new Set([
  '--title', '--project', '--parent-id', '--content', '--desc', '--start-date', '--due-date',
  '--time-zone', '--reminders', '--repeat', '--repeat-from', '--priority', '--sort-order',
  '--items', '--tags', '--id', '--status', '--completed-time', '--estimated-duration',
  '--estimated-pomo', '--from', '--to', '--task', '--assignee', '--tasks', '--projects',
  '--end-date', '--tag', '--kind', '--due-from', '--due-to', '--keywords', '--name', '--color',
  '--view-mode', '--label', '--sort-type', '--parent', '--type', '--new-name', '--scope',
  '--icon-res', '--encouragement', '--goal', '--step', '--unit', '--record-enable',
  '--section-id', '--target-days', '--target-start-date', '--completed-cycles', '--ex-dates',
  '--style', '--stamp', '--time', '--op-time', '--value', '--habits', '--start-time',
  '--end-time', '--task-id', '--note', '--pause-duration', '--adjust-time', '--added',
  '--duration', '--relation-type',
]);

// 可重复、一次能吃多个值的选项（commander 的 <x...>）。
const VARIADIC_FLAGS = new Set(['--from', '--to', '--task']);

const maybeOption = (arg) => arg.length > 1 && arg[0] === '-';

// 复刻 commander 的解析语义：flag 可夹在位置参数之间；-- 之后一律是位置参数；
// variadic 吃到下一个 flag 为止。Windows 的 .cmd 层已经把引号与 %VAR% 处理掉了，
// 这里拿到的是"真 CLI 会看到的 argv"，不需要再解一层引号。
export function parseArgv(argv) {
  const flags = new Map();
  const positionals = [];
  let terminated = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (terminated) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      terminated = true;
      continue;
    }
    if (!maybeOption(arg)) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!flags.has(flag)) flags.set(flag, []);
    if (eq !== -1) {
      flags.get(flag).push(arg.slice(eq + 1));
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      // 布尔选项（--json、--all-day、--help …）
      flags.get(flag).push('true');
      continue;
    }

    // 取它的值。commander 对带值选项总是消费下一个 token，即使它以 - 开头：
    // 实测 `task filter --tag --help` 里 --help 是 tag 的值，真 CLI 照常执行。
    // variadic 则一直吃到下一个 flag 为止。
    while (i + 1 < argv.length) {
      const next = argv[i + 1];
      if (VARIADIC_FLAGS.has(flag) && maybeOption(next)) break;
      i += 1;
      flags.get(flag).push(next);
      if (!VARIADIC_FLAGS.has(flag)) break;
    }
    // 出现但没给值（`--project` 在结尾）：记成空串，交给判定拒绝
    if (flags.get(flag).length === 0) flags.get(flag).push('');
  }

  return { flags, positionals };
}

// 命令路径取 argv 前若干段里能匹配上的最长一条（task comment add 比 task comment 长）。
// 表项有两种形状：写命令是 [path, ...sources]，读命令只给 path。
function pathOf(entry) {
  return Array.isArray(entry[0]) ? entry[0] : entry;
}

function matchLongest(table, argv) {
  const tokens = argv.filter((arg) => !maybeOption(arg));
  let best = null;
  for (const entry of table) {
    const commandPath = pathOf(entry);
    // 顶层选项形式的表项（--help / -V）直接对 argv 首项比，不进 tokens
    const matches = maybeOption(commandPath[0])
      ? argv[0] === commandPath[0]
      : commandPath.every((part, index) => tokens[index] === part);
    if (matches && (!best || commandPath.length > pathOf(best).length)) best = entry;
  }
  return best;
}

function flagValues(parsed, flag) {
  return parsed.flags.get(flag) ?? [];
}

// 只读命令：不解析目标，直接放行。表里没有的命令一律按"未知"拒绝，
// 不默认放行——漏判写命令就是真实数据被改。
export const READ_COMMANDS = [
  ['task', 'get'], ['task', 'completed'], ['task', 'filter'], ['task', 'search'],
  ['task', 'comment', 'list'],
  ['project', 'list'], ['project', 'get'], ['project', 'data'], ['project', 'members'],
  ['project', 'group', 'list'], ['project', 'column', 'list'],
  ['habit', 'get'], ['habit', 'list'], ['habit', 'section', 'list'], ['habit', 'checkins'],
  ['focus', 'get'], ['focus', 'list'],
  ['tag', 'list'],
  ['countdown', 'list'],
  ['preference', 'get'],
  ['auth', 'status'],
];

// 把一条声明解析成目标清单值。空串也算"解析出了一个值"，由调用方判定为不可信。
function sourcesOf(entry) {
  return entry.slice(1).flat();
}

// 位置参数的序号是相对"命令之后的参数"算的，要跳过命令路径占掉的那几格。
function positionalAt(parsed, entry, index) {
  return parsed.positionals[pathOf(entry).length + index];
}

function targetsOf(entry, parsed) {
  const targets = [];
  for (const source of sourcesOf(entry)) {
    if (source.flag) {
      targets.push(...flagValues(parsed, source.flag));
    } else if (source.positional !== undefined) {
      const value = positionalAt(parsed, entry, source.positional);
      if (value !== undefined) targets.push(value);
    }
  }
  return targets;
}

// task update 的定位键是 --id，位置参数只是拼 URL；两者不一致时可能改到别的清单里的任务。
function idMismatch(entry, parsed) {
  for (const source of sourcesOf(entry)) {
    if (!source.sameId) continue;
    const flagValue = flagValues(parsed, source.sameId.flag)[0];
    const positional = positionalAt(parsed, entry, source.sameId.positional);
    if (flagValue && positional && flagValue !== positional) return true;
  }
  return false;
}

export function decide(argv, allowedProjects) {
  const allowed = new Set(allowedProjects ?? []);
  const parsed = parseArgv(argv);

  // 真 CLI 里 --help / --version 在命令分发之前就被 commander 处理，不会执行任何 action。
  // 用 parsed.flags 判断：`--title --help` 里 --help 是值，不会进 flags，也就不会误放行。
  if (['--help', '-h', '--version', '-V'].some((flag) => parsed.flags.has(flag))) {
    return { allow: true, targets: [], reason: null };
  }

  // 空 argv（直接 `dida`）、`help` 子命令：只打印用法。
  if (argv.length === 0 || argv[0] === 'help') {
    return { allow: true, targets: [], reason: null };
  }

  const entry = matchLongest(WRITE_COMMANDS, argv);

  if (!entry) {
    // 读命令放行；既不在写表也不在读表的，按"未知"拒绝——漏判写命令就是真实数据被改。
    if (matchLongest(READ_COMMANDS, argv)) {
      return { allow: true, targets: [], reason: null };
    }
    return { allow: false, targets: [], reason: 'unknown-command' };
  }

  const targets = targetsOf(entry, parsed);
  if (sourcesOf(entry).length === 0) {
    return { allow: false, targets: [], reason: 'no-target' };
  }
  if (idMismatch(entry, parsed)) {
    return { allow: false, targets: [], reason: 'id-mismatch' };
  }
  if (targets.length === 0 || targets.some((value) => value === '')) {
    return { allow: false, targets: targets.filter((value) => value !== ''), reason: 'no-target' };
  }
  const outside = targets.filter((value) => !allowed.has(value));
  if (outside.length > 0) {
    return { allow: false, targets: outside, reason: 'out-of-bounds' };
  }
  return { allow: true, targets, reason: null };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomId(length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

// 与真 CLI 同构：lib/api.js 抛 `DIDA API 错误 <status>: <响应原文>`，index.js 打到 stderr 后退出 1。
// 用 404 + resource_not_found —— 这是实测存在过的形态；errorId 每次随机，别用常量。
export function rejectText({ id } = {}) {
  const body = {
    errorId: `${randomId(8)}@${randomId(5)}`,
    errorCode: 'resource_not_found',
    errorMessage: `project not found: ${id ?? 'unknown'}`,
    data: null,
  };
  return `DIDA API 错误 404: ${JSON.stringify(body)}`;
}

// 真 CLI 在错误路径上退出时会打一行 libuv 断言；转发时吞掉它，
// 否则 agent 会看到与 API 错误无关的进程内部信息。
const NODE_ASSERTION = /^\s*Assertion failed:.*UV_HANDLE_CLOSING.*$/;

export function stripNodeAssertion(text) {
  if (!text) return text;
  return text
    .split(/(?<=\r?\n)/)
    .filter((line) => !NODE_ASSERTION.test(line.replace(/\r?\n$/, '')))
    .join('');
}
