import test from 'node:test';
import assert from 'node:assert/strict';

import { didaInvocations, compareInvocations } from './powershell.mjs';

// 判据要能说出「这条 PowerShell 命令到底跑了哪些 dida 调用」。
// 输入是轨迹里的命令字符串（不是已解析的 argv），所以这里覆盖的是字符串层的切分。
test('裸 dida 是走 shim 的正常调用', () => {
  const out = didaInvocations('dida task get inbox abc');
  assert.deepEqual(out, [{ kind: 'shim', argv: ['task', 'get', 'inbox', 'abc'] }]);
});

test('一条命令里用 ; 串起来的每条 dida 都能单独认出来', () => {
  const out = didaInvocations('dida task create --title a; dida task get inbox b');
  assert.deepEqual(out, [
    { kind: 'shim', argv: ['task', 'create', '--title', 'a'] },
    { kind: 'shim', argv: ['task', 'get', 'inbox', 'b'] },
  ]);
});

test('绝对路径直调真 CLI 是绕过，不是走 shim 的调用', () => {
  const out = didaInvocations('& "D:\\Program Files\\nodejs\\node_global\\dida.cmd" task get inbox abc');
  assert.deepEqual(out, [{ kind: 'bypass', argv: ['task', 'get', 'inbox', 'abc'] }]);
});

test('绝对路径不带空格时不必加引号，同样判绕过', () => {
  const out = didaInvocations('C:\\bin\\dida.cmd project list');
  assert.deepEqual(out, [{ kind: 'bypass', argv: ['project', 'list'] }]);
});

test('与 dida 无关的命令不算调用，也不抬高分母', () => {
  assert.deepEqual(didaInvocations('Get-ChildItem -Force'), []);
  assert.deepEqual(didaInvocations('New-Item -ItemType File notes.md'), []);
});

test('管道与 && 两侧的 dida 都能认出来', () => {
  const out = didaInvocations('dida project list | Select-Object -First 1 && dida task get inbox a');
  assert.deepEqual(out, [
    { kind: 'shim', argv: ['project', 'list'] },
    { kind: 'shim', argv: ['task', 'get', 'inbox', 'a'] },
  ]);
});

test('引号里的分号是参数的一部分，不当作命令分隔符', () => {
  const out = didaInvocations('dida task create --title "a; b"');
  assert.deepEqual(out, [{ kind: 'shim', argv: ['task', 'create', '--title', 'a; b'] }]);
});

test('dida.ps1 与 dida.cmd 的相对名都命中 shim，不单独标记成绕过', () => {
  assert.deepEqual(didaInvocations('dida.cmd task get inbox a'), [{ kind: 'shim', argv: ['task', 'get', 'inbox', 'a'] }]);
  assert.deepEqual(didaInvocations('dida.ps1 task get inbox a'), [{ kind: 'shim', argv: ['task', 'get', 'inbox', 'a'] }]);
});

// 命令里出现了 dida 但首 token 不是可识别的命令名（变量、子表达式）：
// 解析不出来就要说「不知道」，不能当成没调用过——见 #18 的「无法判定」条。
test('命令里出现 dida 却解析不出调用时，标记解析失败', () => {
  const out = didaInvocations('$cmd = "dida"; & $cmd task create');
  assert.ok(out.some((item) => item.kind === 'unparsed'), JSON.stringify(out));
});

// ---- 判据：把轨迹里抽出的调用与调用日志逐条比 ----
// 判据的输出不是条数，而是「哪些调用没对上」。对不上的那次可能就是绕过。

const ps = (command) => ({ name: 'PowerShell', input: { command } });

test('AC1：3 次 PowerShell 里 1 次直调真 CLI，判出不一致', () => {
  const toolCalls = [
    ps('dida task create --title a; dida task create --title b'),
    ps('& "D:\\Program Files\\nodejs\\node_global\\dida.cmd" task create --title c'),
    ps('dida task create --title d; dida task create --title e'),
  ];
  const log = [
    { argv: ['task', 'create', '--title', 'a'] },
    { argv: ['task', 'create', '--title', 'b'] },
    { argv: ['task', 'create', '--title', 'd'] },
    { argv: ['task', 'create', '--title', 'e'] },
  ];
  const out = compareInvocations(toolCalls, log);
  assert.equal(out.status, 'inconsistent');
  assert.equal(out.unmatched.length, 1, JSON.stringify(out));
  assert.match(out.unmatched[0].argv.join(' '), /--title c/);
});

test('AC2：一次 Get-ChildItem 不会被判成绕过', () => {
  const toolCalls = [ps('Get-ChildItem -Force'), ps('dida task get inbox a')];
  const log = [{ argv: ['task', 'get', 'inbox', 'a'] }];
  assert.equal(compareInvocations(toolCalls, log).status, 'consistent');
});

test('AC3：一次 PowerShell 里 3 条 dida，日志里各对得上一条', () => {
  const toolCalls = [ps('dida project list; dida task get inbox a; dida task search --keywords x')];
  const log = [
    { argv: ['project', 'list'] },
    { argv: ['task', 'get', 'inbox', 'a'] },
    { argv: ['task', 'search', '--keywords', 'x'] },
  ];
  assert.equal(compareInvocations(toolCalls, log).status, 'consistent');
});

test('AC4：命令解析不出时判「无法判定」，既不是一致也不是绕过', () => {
  const toolCalls = [ps('$cmd = "dida"; & $cmd task create')];
  const out = compareInvocations(toolCalls, []);
  assert.equal(out.status, 'indeterminate');
});

test('日志里多出来的那条不算绕过：日志只增不减，多记不等于有调用没记', () => {
  const toolCalls = [ps('dida project list')];
  const log = [{ argv: ['project', 'list'] }, { argv: ['task', 'get', 'inbox', 'a'] }];
  assert.equal(compareInvocations(toolCalls, log).status, 'consistent');
});

test('同一条命令重复两次、日志只记一次时判不一致', () => {
  const toolCalls = [ps('dida project list'), ps('dida project list')];
  const log = [{ argv: ['project', 'list'] }];
  const out = compareInvocations(toolCalls, log);
  assert.equal(out.status, 'inconsistent');
  assert.equal(out.unmatched.length, 1);
});

test('被拒绝的调用也算对得上：它确实走过 shim，只是没转发', () => {
  const toolCalls = [ps('dida task create --project zzz --title a')];
  const log = [{ argv: ['task', 'create', '--project', 'zzz', '--title', 'a'], decision: 'rejected' }];
  assert.equal(compareInvocations(toolCalls, log).status, 'consistent');
});

// 误报的代价在 ADR-0014 下是「整条运行什么结论都拿不到」，所以这几条边界必须钉死：
// dida 只是参数、只是输出文本时，那次调用与 dida 无关。
test('dida 只作为别的命令的参数出现时，不算调用', () => {
  assert.deepEqual(didaInvocations('Get-Content a.txt | Select-String dida'), []);
  assert.deepEqual(didaInvocations('echo dida'), []);
  assert.deepEqual(didaInvocations('Write-Output "run dida later"'), []);
});

test('& $cmd 这类动态调用解析不了时仍报无法判定，而不是当作没调用', () => {
  assert.deepEqual(didaInvocations('$cmd = "dida"; & $cmd task create'), [{ kind: 'unparsed' }]);
});

// #18 第二条评论的边界：「解析失败报无法判定」只针对命令里出现了 dida 的情形。
// 与 dida 无关的动态调用（`& $env:ComSpec /c dir`）不该把整条运行判成无法判定。
test('与 dida 无关的动态调用不报无法判定', () => {
  assert.deepEqual(didaInvocations('& $env:ComSpec /c dir'), []);
});

test('反引号续行不断命令，也不把反引号当参数', () => {
  const command = ['dida task create `', '  --title x'].join('\n');
  assert.deepEqual(didaInvocations(command), [{ kind: 'shim', argv: ['task', 'create', '--title', 'x'] }]);
});

// 误报比漏报更贵：ADR-0014 下可信度误报会让整条运行连快照都不取，
// 而 agent 每次都要用 PowerShell 做文件操作。下面这些是真实会出现的写法。
test('赋值、取变量、查文件这类日常写法都不会被判成无法判定', () => {
  assert.deepEqual(didaInvocations('$files = Get-ChildItem'), []);
  assert.deepEqual(didaInvocations('$x = 1'), []);
  assert.deepEqual(didaInvocations('foreach ($f in $files) { Copy-Item $f out }'), []);
});

test('赋值后再用变量调用仍算无法判定——那段真的不知道跑没跑', () => {
  assert.deepEqual(didaInvocations('$cmd = "dida"; & $cmd task create'), [{ kind: 'unparsed' }]);
});

// PowerShell 里真实会写的控制流、重定向、赋值形态。误判任何一条都会让整条运行判不了。
test('花括号里的 dida 调用要能认出来（if / try 块）', () => {
  assert.deepEqual(didaInvocations('if ($true) { dida project list }'), [{ kind: 'shim', argv: ['project', 'list'] }]);
  assert.deepEqual(didaInvocations('try { dida task get inbox x } catch { $_ }'), [{ kind: 'shim', argv: ['task', 'get', 'inbox', 'x'] }]);
});

test('重定向记号不进 argv', () => {
  assert.deepEqual(didaInvocations('dida task get inbox x 2>&1 | Out-Null'), [{ kind: 'shim', argv: ['task', 'get', 'inbox', 'x'] }]);
});

test('把 dida 的输出赋给变量仍是 dida 调用', () => {
  assert.deepEqual(didaInvocations('$r = dida project list; $r'), [{ kind: 'shim', argv: ['project', 'list'] }]);
});

test('把字符串 dida 赋给变量不是调用', () => {
  assert.deepEqual(didaInvocations('$cmd = "dida"' ), []);
});

test('裸变量单独一行只是求值，不判成动态调用', () => {
  assert.deepEqual(didaInvocations('$r'), []);
  assert.deepEqual(didaInvocations('$r = dida project list; $r'), [{ kind: 'shim', argv: ['project', 'list'] }]);
});

test('&& 与 || 都是段边界', () => {
  assert.deepEqual(didaInvocations('dida project list && dida task get inbox a'), [
    { kind: 'shim', argv: ['project', 'list'] },
    { kind: 'shim', argv: ['task', 'get', 'inbox', 'a'] },
  ]);
  assert.deepEqual(didaInvocations('dida project list || dida task get inbox a'), [
    { kind: 'shim', argv: ['project', 'list'] },
    { kind: 'shim', argv: ['task', 'get', 'inbox', 'a'] },
  ]);
});

test('大写 DIDA.CMD 也算 dida，Windows 上文件名不区分大小写', () => {
  assert.deepEqual(didaInvocations('DIDA.CMD task get inbox a'), [{ kind: 'shim', argv: ['task', 'get', 'inbox', 'a'] }]);
});

// 轨迹里是命令字符串，shim 记的是 PowerShell 展开后的 argv。两边必须在常见写法下对齐，
// 否则每次运行都会「对不上」。这条钉住最典型的几种带引号参数。
test('引号包裹的参数与 shim 收到的 argv 对得上', () => {
  const cases = [
    ['dida task create --title "含 空格"', ['task', 'create', '--title', '含 空格']],
    ["dida task create --title 'single quoted'", ['task', 'create', '--title', 'single quoted']],
    ['dida task create --title ""', ['task', 'create', '--title', '']],
  ];
  for (const [command, argv] of cases) {
    assert.deepEqual(
      compareInvocations([ps(command)], [{ argv }]).status,
      'consistent',
      `${command} 应能与日志对上`,
    );
  }
});

// 审查发现的真实形态。每一条都对应一次「运行必然误报」或「绕过被藏起来」。
test('换行也是命令分隔符——多行命令里的绕过不能被吞进上一行的参数', () => {
  const command = ['dida project list', String.raw`C:\bin\dida.cmd task create --title x`].join('\n');
  const out = compareInvocations([ps(command)], [{ argv: ['project', 'list'] }]);
  assert.equal(out.status, 'inconsistent');
  assert.deepEqual(out.unmatched.map((call) => call.argv), [['task', 'create', '--title', 'x']]);
});

test('重定向粘在一起（2>$null / >NUL / *>$null）不污染 argv', () => {
  for (const tail of ['2>$null', '2>NUL', '>$null', '*>$null']) {
    assert.deepEqual(
      didaInvocations(`dida task get inbox a ${tail}`),
      [{ kind: 'shim', argv: ['task', 'get', 'inbox', 'a'] }],
      tail,
    );
  }
});

test('引号外的行尾注释不当作参数', () => {
  assert.deepEqual(didaInvocations('dida task get inbox a # check it'), [{ kind: 'shim', argv: ['task', 'get', 'inbox', 'a'] }]);
});

test('引号内的 # 是参数，不当注释', () => {
  assert.deepEqual(didaInvocations('dida task create --title "#tag"'), [{ kind: 'shim', argv: ['task', 'create', '--title', '#tag'] }]);
});

// skill 文档自己就教 agent 用 `$task.id`。这类 argv 在轨迹里是变量名、日志里是展开值，
// 逐字比永远不等；但调用确实走过 shim，不能因此判整条运行无效。
test('argv 里的变量不逐字比，改为按条数认领日志', () => {
  const out = compareInvocations(
    [ps('dida task get inbox $task.id --json')],
    [{ argv: ['task', 'get', 'inbox', '68abc', '--json'] }],
  );
  assert.equal(out.status, 'consistent');
});

test('argv 带变量但日志里一条都没有时仍判不一致', () => {
  const out = compareInvocations([ps('dida task get inbox $task.id')], []);
  assert.equal(out.status, 'inconsistent');
});

// 运行目录 shim/ 里的 dida.cmd 是 shim 的壳，写绝对路径也能命中它（PATH 之外的全名调用）。
// 那种调用有日志，不是绕过；判据得知道运行目录才能区分。
test('运行目录 shim/ 下的绝对路径仍是 shim，不是绕过', () => {
  const sandboxBin = String.raw`C:\Temp\run-abc123\shim`;
  const out = compareInvocations(
    [ps(String.raw`C:\Temp\run-abc123\shim\dida.cmd task get inbox a`)],
    [{ argv: ['task', 'get', 'inbox', 'a'] }],
    { shimDir: sandboxBin },
  );
  assert.equal(out.status, 'consistent', JSON.stringify(out));
});

test('运行目录以外的绝对路径仍是绕过', () => {
  const out = compareInvocations(
    [ps(String.raw`C:\other\dida.cmd task get inbox a`)],
    [{ argv: ['task', 'get', 'inbox', 'a'] }],
    { shimDir: String.raw`C:\Temp\run-abc123\shim` },
  );
  assert.equal(out.status, 'inconsistent', JSON.stringify(out));
});
