// 轨迹里的 PowerShell 调用只给了命令字符串，要从中抽出「这次到底跑了哪些 dida 调用」。
// shim 那边拿到的是已解析的 argv 数组（guard.mjs 的 parseArgv），这里是字符串层，
// 多一层切分：`;`、`&&`、`||`、`|`、`&`、`{`、`}`、换行都能把一条命令拆成多次调用。
//
// 只按命令名判 dida（`dida`、`dida.ps1`、`dida.cmd` 都算）：相对名命中沙箱 bin/ 的壳，
// 带路径的是直调真 CLI（与 #13 的入口讨论一致）。
export function didaInvocations(command) {
  const out = [];
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment.text);
    if (tokens.length === 0) continue;
    // 赋值：等号不执行命令，但右边可能是一条 dida 调用（`$r = dida project list`）。
    // 右边首字符是引号时是字面量——`$cmd = "dida"` 只把字符串存起来，不执行。
    // tokenize 已经剥掉了引号，所以这条得看原始文本。
    if (tokens[1] === '=') {
      const eqAt = segment.text.indexOf('=');
      const rhsText = segment.text.slice(eqAt + 1).trim();
      if (rhsText === '' || /^[$"']/.test(rhsText)) continue;
      const kind = didaInvocationKind(tokens[2]);
      if (kind) out.push({ kind, argv: stopAtRedirection(tokens.slice(3)) });
      continue;
    }
    const kind = didaInvocationKind(tokens[0]);
    if (kind) {
      out.push({ kind, argv: stopAtRedirection(tokens.slice(1)) });
      continue;
    }
    // `& $cmd ...` 这种动态调用：命令名是变量，解析不出跑没跑，要报无法判定。
    // 判据是这段紧跟在调用运算符 `&` 后面；`$r` 单独一行只是求值打印，不是调用。
    if (segment.invoked && /^[$&(]/.test(tokens[0])) out.push({ kind: 'unparsed' });
  }
  return out;
}

// 裸名命中 PATH 上沙箱 bin/ 的壳；带路径分隔符的是直调真 CLI，shim 记不到。
function didaInvocationKind(token) {
  if (basenameWithoutExtension(token) !== 'dida') return null;
  return /[\\/]/.test(token) ? 'bypass' : 'shim';
}

function basenameWithoutExtension(token) {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.replace(/\.(cmd|ps1|exe|bat)$/i, '').toLowerCase();
}

// 判据：把轨迹里每次 dida 调用与调用日志逐条对，而不是比总数。
// 对不上的调用 = 日志里找不到对应 argv 的那次，也就是「它运行了但我没记账」。
//
// 匹配按**多条日志顺序消耗**，不做全量配对：同一条命令跑两遍、日志只记一条，
// 第二遍就是没对上——全量配对会把这一次的缺口藏在重复项里。
// 日志里多出来的条目不算缺口：shim 只在调用发生时追加，多记说明有次调用没进轨迹
// （例如会话在写轨迹前被杀），那不是绕过。
export function compareInvocations(toolCalls, log) {
  if (!Array.isArray(log)) return { status: 'indeterminate', unmatched: [], reason: 'no-log' };
  const remaining = log.filter((entry) => !entry.unparseable).map((entry) => entry.argv ?? []);
  const unmatched = [];

  for (const call of toolCalls ?? []) {
    if (call.name !== 'PowerShell') continue;
    const command = call.input?.command;
    // 轨迹里没有命令文本就无法判断这次调用的性质：宁可说「不知道」。
    if (typeof command !== 'string') {
      return { status: 'indeterminate', unmatched, reason: 'no-command' };
    }
    for (const invocation of didaInvocations(command)) {
      if (invocation.kind === 'unparsed') {
        return { status: 'indeterminate', unmatched, reason: 'unparsed' };
      }
      if (invocation.kind === 'bypass') {
        unmatched.push(invocation);
        continue;
      }
      // argv 里有没展开的变量（`$task.id`）时不能逐字比：日志记的是展开后的值。
      // 但这条调用确实带着 dida 命令名，shim 应该收到过——按条数认领一条日志，
      // 逐字比对留给能比的那些。判成「无法判定」会让每次真实调用都终止整条运行
      // （skill 文档自己就教用 `$task.id`），代价更大。
      if (invocation.argv.some((token) => /\$[\w(]/.test(token))) {
        if (remaining.length === 0) unmatched.push(invocation);
        else remaining.shift();
        continue;
      }
      const at = remaining.findIndex((argv) => sameArgv(argv, invocation.argv));
      if (at === -1) unmatched.push(invocation);
      else remaining.splice(at, 1);
    }
  }

  return {
    status: unmatched.length === 0 ? 'consistent' : 'inconsistent',
    unmatched,
  };
}

function sameArgv(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// 重定向不是传给 dida 的参数：`2>$null`、`2>NUL`、`>$null`、`*>$null`、`2>&1`、`>`。
// 这些由切段时 `&` / `>` 被拆开或原样留下，按形态剔掉。
// 注释（`# ...`）在切段时按「引号外的 #」剥掉，不在这里处理——tokenize 之后
// 引号信息已丢，`--title "#tag"` 会被误当成注释。
function stopAtRedirection(argv) {
  const at = argv.findIndex((token) => /^[*\d]?>/.test(token));
  return at === -1 ? argv : argv.slice(0, at);
}

// 按命令分隔符切段。引号内的分隔符不切：`--title "a; b"` 里的分号是参数的一部分。
// `invoked` 标出这一段是不是紧跟在 `&` 调用运算符后面——只有那种段的首 token
// 才是「被执行」的，`& $cmd` 里的 `$cmd` 值得报无法判定，裸 `$r` 不值得。
function splitSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  let invoked = false;
  const push = () => {
    segments.push({ text: current, invoked });
    current = '';
    invoked = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    // 引号外的 `#` 是注释，到行尾为止。留着会把注释文字当成 dida 的参数。
    // 段在这里结束，但注释后面没有可执行的命令，直接跳到行尾即可。
    if (ch === '#') {
      while (i < command.length && command[i] !== '\n' && command[i] !== '\r') i += 1;
      push();
      continue;
    }
    // 换行也是命令分隔符：agent 常用多行写命令，不切会把下一行整个当成本行的参数——
    // 那条真正执行的命令（可能是绕过）就被藏起来了。见 #18 的审查记录。
    if (ch === '&' || ch === '|' || ch === ';' || ch === '{' || ch === '}'
      || ch === '\n' || ch === '\r') {
      // `&&` 与 `||` 是逻辑运算符，与 `&`、`|` 一样都是段边界；连续的分隔符只切一次。
      const next = command[i + 1];
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) i += 1;
      push();
      invoked = ch === '&';
      continue;
    }
    current += ch;
  }
  segments.push({ text: current, invoked });
  return segments;
}

// 按空白切词，但保留引号里的空白：`"D:\Program Files\...\dida.cmd"` 是一个 token。
// 引号本身在切词时去掉——真 CLI 收到的 argv 里没有它们。
function tokenize(segment) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}
