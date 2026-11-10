import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { decide, parseArgv, rejectText, stripNodeAssertion } from './guard.mjs';
import { outOfBoundsCalls, parseCallLog, rejectedCalls } from './calllog.mjs';
import { renderGuardConfig } from './sandbox.mjs';

const WHITE = '69abc459ebbdbd00000009f0';
const WHITE2 = '59f736cae4b060e424059e3b';
const BLACK = '0000000000000000000000ff';
const ALLOWED = [WHITE, WHITE2];

const SHIM_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dida-shim.mjs');
const LIB_SOURCE = path.dirname(fileURLToPath(import.meta.url));

function verdict(argv) {
  return decide(argv, ALLOWED);
}

describe('放行 · 只读命令', () => {
  const reads = [
    ['task', 'get', BLACK, 't1'],
    ['task', 'filter', '--projects', BLACK],
    ['task', 'completed', '--projects', BLACK],
    ['task', 'search', '关键词', '--projects', BLACK],
    ['task', 'comment', 'list', BLACK, 't1'],
    ['project', 'list'],
    ['project', 'get', BLACK],
    ['project', 'data', BLACK],
    ['project', 'members', BLACK],
    ['project', 'group', 'list'],
    ['project', 'column', 'list', BLACK],
    ['habit', 'get', 'h1'],
    ['habit', 'list'],
    ['habit', 'section', 'list'],
    ['habit', 'checkins', '--habits', 'h1', '--from', '20260101', '--to', '20260102'],
    ['focus', 'get', 'f1'],
    ['focus', 'list', '--from', '2026-01-01T00:00:00+0800', '--to', '2026-01-02T00:00:00+0800', '--type', '0'],
    ['tag', 'list'],
    ['countdown', 'list'],
    ['preference', 'get'],
    ['auth', 'status'],
    ['--help'],
    ['--version'],
    [],                       // 直接 `dida`
    ['help'],                 // `dida help`
    ['help', 'task'],
    ['task'],                 // `dida task`：打印该组用法
    ['project'],
    ['habit'],
    ['project', 'group'],     // 嵌套组：真 CLI 同样只打印用法
    ['project', 'column'],
    ['task', 'comment'],
    ['habit', 'section'],
    ['task', 'help'],         // `dida task help`
    ['project', 'help'],
    ['project', 'group', 'help'],   // 嵌套组的 help
    ['task', 'comment', 'help'],
    ['task', 'create', '--help'],   // --help 在命令分发前被 commander 处理
    ['task', '--help'],
    ['project', 'delete', '-h'],
  ];

  for (const argv of reads) {
    test(`放行：${argv.join(' ')}`, () => {
      assert.deepEqual(verdict(argv), { allow: true, targets: [], reason: null });
    });
  }
});

describe('放行 · 目标清单合法', () => {
  const writes = [
    ['task', 'create', '--title', 'x', '--project', WHITE],
    ['task', 'create', '--title', 'x', `--project=${WHITE2}`],
    ['task', 'complete-batch', '--project', WHITE, '--tasks', 'a,b'],
    ['task', 'move', '--from', WHITE, '--to', WHITE2, '--task', 't1'],
    ['task', 'move', '--from', WHITE, '--from', WHITE2, '--to', WHITE, '--task', 't1', '--task', 't2'],
    ['task', 'complete', WHITE, 't1'],
    ['task', 'delete', WHITE, 't1'],
    ['task', 'comment', 'add', WHITE, 't1', '--title', '备注'],
    ['task', 'comment', 'delete', WHITE, 't1', 'c1'],
    ['task', 'assign', '--project', WHITE, '--task', 't1', '--assignee', 'u'],
    ['task', 'unassign', '--project', WHITE, '--task', 't1'],
    ['task', 'update', 't1', '--id', 't1', '--project', WHITE, '--title', 'x'],
    ['project', 'update', WHITE, '--name', 'x'],
    ['project', 'delete', WHITE],
    ['project', 'column', 'create', WHITE, '--name', '列'],
    ['project', 'column', 'update', WHITE, 'c1', '--name', '列'],
  ];

  for (const argv of writes) {
    test(`放行：${argv.join(' ')}`, () => {
      assert.equal(verdict(argv).allow, true);
    });
  }

  test('放行时把解析到的目标报出来，供日志留痕', () => {
    assert.deepEqual(verdict(['task', 'create', '--title', 'x', '--project', WHITE]).targets, [WHITE]);
  });

  test('放行：task move 的多个目标全部合法', () => {
    const result = verdict(['task', 'move', '--from', WHITE, '--to', WHITE2, '--task', 't1']);
    assert.deepEqual(result.targets, [WHITE, WHITE2]);
  });
});

describe('拒绝 · 清单越界', () => {
  test('variadic 的第一个值即使以 - 开头也照收，--help 在那里是值不是帮助', () => {
    // 实测真 CLI：这两条都 exit 0，真的把任务移到了非测试清单
    const a = verdict(['task', 'move', '--from', WHITE, '--to', BLACK, '--task', '--help']);
    assert.equal(a.allow, false);
    assert.equal(a.reason, 'out-of-bounds');
    const b = verdict(['task', 'move', '--from', '--help', '--to', BLACK, '--task', 't1']);
    assert.equal(b.allow, false);
    assert.equal(b.reason, 'out-of-bounds');
  });
  test('--help 被当成选项值消费时不算帮助，写命令照常判定', () => {
    // 真 CLI 实测：`task create --title --help --project <真实清单>` 会真的创建任务
    const result = verdict(['task', 'create', '--title', '--help', '--project', BLACK]);
    assert.equal(result.allow, false);
    assert.equal(result.reason, 'out-of-bounds');
  });

  test('= 形式的选项值里含 --help 也不算帮助', () => {
    assert.equal(verdict(['task', 'create', '--title=--help', '--project', BLACK]).allow, false);
  });

  test('-- 之后的 --help 是位置参数，不算帮助', () => {
    assert.equal(verdict(['task', 'delete', '--', BLACK, '--help']).allow, false);
  });

  const outOfBounds = [
    ['task', 'create', '--title', 'x', '--project', BLACK],
    ['task', 'create', '--title', 'x', '--project', 'inbox'],
    ['task', 'update', 't1', '--id', 't1', '--project', BLACK, '--title', 'x'],
    ['task', 'move', '--from', WHITE, '--to', BLACK, '--task', 't1'],
    ['task', 'move', '--from', BLACK, '--to', WHITE, '--task', 't1'],
    ['task', 'complete', BLACK, 't1'],
    ['task', 'delete', BLACK, 't1'],
    ['task', 'comment', 'add', BLACK, 't1', '--title', 'x'],
    ['task', 'comment', 'delete', BLACK, 't1', 'c1'],
    ['task', 'assign', '--project', BLACK, '--task', 't1', '--assignee', 'u'],
    ['task', 'unassign', '--project', BLACK, '--task', 't1'],
    ['task', 'complete-batch', '--project', BLACK, '--tasks', 'a'],
    ['project', 'update', BLACK, '--name', 'x'],
    ['project', 'delete', BLACK],
    ['project', 'column', 'create', BLACK, '--name', '列'],
    ['project', 'column', 'update', BLACK, 'c1', '--name', '列'],
  ];

  for (const argv of outOfBounds) {
    test(`拒绝：${argv.join(' ')}`, () => {
      const result = verdict(argv);
      assert.equal(result.allow, false);
      assert.equal(result.reason, 'out-of-bounds');
    });
  }

  test('拒绝时记下越界的那一个目标', () => {
    assert.deepEqual(verdict(['task', 'move', '--from', WHITE, '--to', BLACK, '--task', 't1']).targets, [BLACK]);
  });

  test('一个合法一个越界，仍然拒绝（--project 重复时全部校验）', () => {
    assert.equal(verdict(['task', 'create', '--title', 'x', '--project', BLACK, '--project', WHITE]).allow, false);
  });
});

describe('拒绝 · 解析不出目标', () => {
  const noTarget = [
    ['task', 'create', '--title', 'x'],
    ['task', 'update', 't1', '--id', 't1', '--title', 'x'],
    ['task', 'complete-batch', '--tasks', 'a'],
    ['task', 'create', '--title', 'x', '--project='],
    ['project', 'create', '--name', 'x'],
    ['project', 'group', 'create', '--name', 'g'],
    ['project', 'group', 'update', 'g1', '--name', 'g'],
    ['project', 'group', 'delete', 'g1'],
    ['habit', 'create', '--name', 'h'],
    ['habit', 'update', 'h1', '--name', 'h'],
    ['habit', 'checkin', 'h1', '--stamp', '20260101'],
    ['focus', 'create', '--type', '0', '--start-time', '2026-01-01T00:00:00+0800', '--end-time', '2026-01-01T00:25:00+0800'],
    ['focus', 'update', 'f1', '--type', '0'],
    ['focus', 'delete', 'f1', '--type', '0'],
    ['tag', 'create', '--name', 'a', '--label', 'a'],
    ['tag', 'update', '--name', 'a'],
    ['tag', 'rename', '--name', 'a', '--new-name', 'b'],
    ['tag', 'delete', '--name', 'a'],
    ['auth', 'login'],
    ['auth', 'logout'],
    ['auth', 'token', 'tok'],
  ];

  for (const argv of noTarget) {
    test(`拒绝：${argv.join(' ')}`, () => {
      const result = verdict(argv);
      assert.equal(result.allow, false);
      assert.equal(result.reason, 'no-target');
    });
  }

  test('未知命令默认拒绝，不因为表里没有就放行', () => {
    const result = verdict(['task', 'frobnicate', '--project', WHITE]);
    assert.equal(result.allow, false);
    assert.equal(result.reason, 'unknown-command');
  });
});

describe('拒绝 · 双 id 不一致', () => {
  test('task update 的位置参数与 --id 不同：拒绝', () => {
    const result = verdict(['task', 'update', 't1', '--id', 't2', '--project', WHITE]);
    assert.equal(result.allow, false);
    assert.equal(result.reason, 'id-mismatch');
  });

  test('两者相同且目标合法：放行', () => {
    assert.equal(verdict(['task', 'update', 't1', '--id', 't1', '--project', WHITE]).allow, true);
  });

  test('--id 重复且不同：拒绝（commander 后写覆盖，body 用的是最后一个）', () => {
    const result = verdict(['task', 'update', 't1', '--id', 't1', '--id', 't2', '--project', WHITE]);
    assert.equal(result.allow, false);
    assert.equal(result.reason, 'id-mismatch');
  });
});

describe('参数解析', () => {
  test('--flag=value 与 --flag value 等价', () => {
    const inline = parseArgv(['task', 'create', `--project=${WHITE}`]);
    const spaced = parseArgv(['task', 'create', '--project', WHITE]);
    assert.deepEqual(inline.flags.get('--project'), spaced.flags.get('--project'));
  });

  test('flag 夹在位置参数中间也算位置参数', () => {
    const parsed = parseArgv(['task', 'complete', '--json', WHITE, 't1']);
    // positionals 含命令路径；判定按命令路径长度跳过它们
    assert.deepEqual(parsed.positionals, ['task', 'complete', WHITE, 't1']);
  });

  test('variadic 一直吃到下一个 flag 为止', () => {
    const parsed = parseArgv(['task', 'move', '--from', WHITE, WHITE2, '--to', BLACK, '--task', 't1']);
    assert.deepEqual(parsed.flags.get('--from'), [WHITE, WHITE2]);
    assert.deepEqual(parsed.flags.get('--to'), [BLACK]);
  });

  test('-- 之后一律当位置参数', () => {
    const parsed = parseArgv(['task', 'delete', '--', BLACK, 't1']);
    assert.deepEqual(parsed.positionals, ['task', 'delete', BLACK, 't1']);
    assert.equal(verdict(['task', 'delete', '--', BLACK, 't1']).allow, false);
  });

  test('重复 flag 全部收集，不只取第一个', () => {
    assert.deepEqual(parseArgv(['task', 'create', '--project', BLACK, '--project', WHITE]).flags.get('--project'), [BLACK, WHITE]);
  });

  test('--project= 记成空串而不是丢掉', () => {
    assert.deepEqual(parseArgv(['task', 'create', '--project=']).flags.get('--project'), ['']);
  });

  test('带值选项总消费下一个 token，即使它以 - 开头（实测真 CLI 行为）', () => {
    // 实测：`dida task filter --tag --help` 里 --help 是 --tag 的值，命令照常执行、不打印帮助
    assert.deepEqual(parseArgv(['task', 'filter', '--tag', '--help']).flags.get('--tag'), ['--help']);
    // 于是写命令里同样的写法必须按真实目标判定，不能被当成帮助放行
    assert.equal(verdict(['task', 'create', '--title', '--help', '--project', BLACK]).allow, false);
  });
});

describe('拒绝文本', () => {
  test('形如真 CLI 的 API 错误，写在 stderr 的一行', () => {
    const text = rejectText({ id: BLACK });
    assert.match(text, /^DIDA API 错误 404: \{.*\}$/);
    assert.ok(!text.endsWith('\n'), '换行由调用方补，函数本身不带');
  });

  test('正文是可解析的 JSON，字段与真 CLI 一致', () => {
    const json = JSON.parse(rejectText({ id: BLACK }).replace(/^DIDA API 错误 \d+: /, ''));
    assert.deepEqual(Object.keys(json).sort(), ['data', 'errorCode', 'errorId', 'errorMessage']);
    assert.equal(json.errorCode, 'resource_not_found');
    assert.equal(json.data, null);
    assert.match(json.errorMessage, /project not found/);
  });

  test('errorId 每次不同', () => {
    const idOf = (text) => JSON.parse(text.replace(/^DIDA API 错误 \d+: /, '')).errorId;
    assert.notEqual(idOf(rejectText({ id: BLACK })), idOf(rejectText({ id: BLACK })));
  });

  test('不暴露测试机制', () => {
    const text = rejectText({ id: BLACK });
    for (const word of ['测试', 'shim', 'harness', '清单集合', '测试清单', 'HARNESS']) {
      assert.ok(!text.includes(word), `不应包含「${word}」：${text}`);
    }
  });
});

describe('断言行过滤', () => {
  const ASSERT_LINE = 'Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76';

  test('滤掉 UV_HANDLE_CLOSING 那一行，其它原样保留', () => {
    const input = `DIDA API 错误 500: {"errorCode":"x"}\n${ASSERT_LINE}\n`;
    assert.equal(stripNodeAssertion(input), 'DIDA API 错误 500: {"errorCode":"x"}\n');
  });

  test('CRLF 换行同样能滤掉', () => {
    const input = `第一行\r\n${ASSERT_LINE}\r\n`;
    assert.equal(stripNodeAssertion(input), '第一行\r\n');
  });

  test('没有断言行时逐字节不变', () => {
    const input = '普通输出\n第二行\n';
    assert.equal(stripNodeAssertion(input), input);
  });

  test('空输入不报错', () => {
    assert.equal(stripNodeAssertion(''), '');
  });
});

describe('调用日志留痕', () => {
  test('记录里能带判定结果，parseCallLog 照常读出', () => {
    const text = `${JSON.stringify({ argv: ['task', 'delete', BLACK, 't1'], at: '2026-11-10T00:00:00.000Z', decision: 'rejected', reason: 'out-of-bounds', targets: [BLACK] })}\n`;
    const [entry] = parseCallLog(text);
    assert.equal(entry.decision, 'rejected');
    assert.equal(entry.reason, 'out-of-bounds');
    assert.deepEqual(entry.targets, [BLACK]);
  });

  test('越界写入与解析不出目标分开统计（越界写入是 GLOSSARY 的专有概念）', () => {
    const calls = [
      { decision: 'allow' },
      { decision: 'rejected', reason: 'out-of-bounds' },
      { decision: 'rejected', reason: 'no-target' },
      { decision: 'rejected', reason: 'unknown-command' },
      { decision: 'rejected', reason: 'id-mismatch' },
    ];
    assert.equal(rejectedCalls(calls).length, 4);
    assert.deepEqual(outOfBoundsCalls(calls).map((c) => c.reason), ['out-of-bounds']);
  });
});

describe('集成 · 真正 spawn shim', () => {
  // 假 CLI：先把 argv 落进 marker 证明自己被执行过，再按 FAKE_EXIT 退出。
  const FAKE = [
    "import fs from 'node:fs';",
    "const argv = process.argv.slice(2);",
    "fs.writeFileSync(process.env.FAKE_MARKER, JSON.stringify(argv));",
    "if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);",
    "process.stdout.write(process.env.FAKE_STDOUT ?? '');",
    "process.exit(Number(process.env.FAKE_EXIT ?? '0'));",
    '',
  ].join('\n');

  // 用生产代码的模板生成白名单，避免测试复制一份实现后生产路径零覆盖。
  function bakeProjects(ctx, projects) {
    fs.writeFileSync(path.join(ctx.binDir, 'lib', 'guard-config.mjs'), renderGuardConfig(projects));
  }

  function setup(t, projects = ALLOWED) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fakePath = path.join(dir, 'fake.mjs');
    fs.writeFileSync(fakePath, FAKE);

    // 照沙箱的布局摆一份 shim：bin/dida-shim.mjs + bin/lib/*，好让它的相对 import 生效。
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(path.join(binDir, 'lib'), { recursive: true });
    fs.copyFileSync(SHIM_SOURCE, path.join(binDir, 'dida-shim.mjs'));
    for (const name of fs.readdirSync(LIB_SOURCE)) {
      if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue;
      fs.copyFileSync(path.join(LIB_SOURCE, name), path.join(binDir, 'lib', name));
    }

    const ctx = {
      dir,
      fakePath,
      binDir,
      marker: path.join(dir, 'marker.json'),
      callLog: path.join(dir, 'calls.ndjson'),
      created: path.join(dir, 'created.ndjson'),
    };
    bakeProjects(ctx, projects);
    return ctx;
  }

  function runShim(env, ctx, argv) {
    return spawnSync(
      process.execPath,
      [path.join(ctx.binDir, 'dida-shim.mjs'), process.execPath, ctx.fakePath, ...argv],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          FAKE_MARKER: ctx.marker,
          DIDA_CALL_LOG: ctx.callLog,
          DIDA_CREATED_FILE: ctx.created,
          ...env,
        },
      },
    );
  }

  test('越界写入被拒：假 CLI 从未被启动', (t) => {
    const ctx = setup(t);
    const result = runShim({}, ctx, ['task', 'create', '--title', 'x', '--project', BLACK]);

    assert.equal(fs.existsSync(ctx.marker), false, '写请求不该发出去');
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^DIDA API 错误 404: /);
    assert.equal(result.status, 1);
  });

  test('被拒的调用在调用日志里留痕', (t) => {
    const ctx = setup(t);
    runShim({}, ctx, ['task', 'delete', BLACK, 't1']);

    const [entry] = parseCallLog(fs.readFileSync(ctx.callLog, 'utf8'));
    assert.deepEqual(entry.argv, ['task', 'delete', BLACK, 't1']);
    assert.equal(entry.decision, 'rejected');
    assert.equal(entry.reason, 'out-of-bounds');
  });

  test('测试清单集合为空时写命令被拒，且不暴露机制', (t) => {
    const ctx = setup(t, []);
    const result = runShim({}, ctx, ['task', 'create', '--title', 'x', '--project', WHITE]);

    assert.equal(fs.existsSync(ctx.marker), false);
    assert.match(result.stderr, /^DIDA API 错误 404: /);
    assert.equal(result.status, 1);
  });

  test('测试清单集合为空时读命令照常转发', (t) => {
    const ctx = setup(t, []);
    const result = runShim({}, ctx, ['task', 'get', WHITE, 't1']);

    assert.deepEqual(JSON.parse(fs.readFileSync(ctx.marker, 'utf8')), ['task', 'get', WHITE, 't1']);
    assert.equal(result.status, 0);
  });

  test('被测 agent 覆盖 DIDA_TEST_PROJECTS 也绕不过：白名单不来自环境变量', (t) => {
    const ctx = setup(t);
    // 模拟 agent 在 PowerShell 里把真实清单塞进环境，再调 shim
    const result = runShim({ DIDA_TEST_PROJECTS: BLACK }, ctx, ['task', 'create', '--title', 'x', '--project', BLACK]);

    assert.equal(fs.existsSync(ctx.marker), false, '写请求不该发出去');
    assert.equal(result.status, 1);
    assert.equal(parseCallLog(fs.readFileSync(ctx.callLog, 'utf8'))[0].decision, 'rejected');
  });

  test('目标合法：原样转发，argv 一致', (t) => {
    const ctx = setup(t);
    const argv = ['task', 'create', '--title', '含 空格', '--project', WHITE];
    const result = runShim({}, ctx, argv);

    assert.deepEqual(JSON.parse(fs.readFileSync(ctx.marker, 'utf8')), argv);
    assert.equal(result.status, 0);
  });

  test('目标合法：输出与直跑假 CLI 逐字节相同', (t) => {
    const ctx = setup(t);
    const overrides = {
      FAKE_STDOUT: '已创建: x\nID: 6aee00000000000000000001\n',
      FAKE_STDERR: 'note\r\n',
      FAKE_EXIT: '0',
    };
    const argv = ['task', 'create', '--title', 'x', '--project', WHITE];
    const viaShim = runShim(overrides, ctx, argv);
    const direct = spawnSync(process.execPath, [ctx.fakePath, ...argv], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, FAKE_MARKER: ctx.marker, ...overrides },
    });

    assert.equal(viaShim.stdout, direct.stdout);
    assert.equal(viaShim.stderr, direct.stderr);
  });

  test('退出码透传', (t) => {
    const ctx = setup(t);
    for (const code of ['0', '3']) {
      const result = runShim({ FAKE_EXIT: code }, ctx, ['task', 'get', WHITE, 't1']);
      assert.equal(result.status, Number(code));
    }
  });

  test('转发时吞掉真 CLI 的 Node 断言行', (t) => {
    const ctx = setup(t);
    const result = runShim(
      {
        FAKE_STDERR: 'DIDA API 错误 500: {"x":1}\nAssertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76\r\n',
        FAKE_EXIT: '1',
      },
      ctx,
      ['task', 'get', WHITE, 't1'],
    );

    assert.match(result.stderr, /DIDA API 错误 500/);
    assert.doesNotMatch(result.stderr, /UV_HANDLE_CLOSING/);
  });

  // 这条之前没有：把 shim 的 `if (!verdict.allow)` 收窄成只认 out-of-bounds，
  // 全部单测仍然全绿，而 id-mismatch 之类的写会被真的转发出去。
  const REJECTIONS = [
    ['清单越界', 'out-of-bounds', ['task', 'delete', BLACK, 't1']],
    ['解析不出目标', 'no-target', ['task', 'create', '--title', 'x']],
    ['双 id 不一致', 'id-mismatch', ['task', 'update', 't1', '--id', 't2', '--project', WHITE]],
    ['未知命令', 'unknown-command', ['task', 'frobnicate', '--project', WHITE]],
    ['无目标清单的写命令', 'no-target', ['habit', 'checkin', 'h1', '--stamp', '20260101']],
  ];

  for (const [label, reason, argv] of REJECTIONS) {
    test(`每一种拒绝原因都不转发：${label}`, (t) => {
      const ctx = setup(t);
      const result = runShim({}, ctx, argv);

      assert.equal(fs.existsSync(ctx.marker), false, `${label}不该发出去`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^DIDA API 错误 404: /);
      assert.equal(result.status, 1);
      const [entry] = parseCallLog(fs.readFileSync(ctx.callLog, 'utf8'));
      assert.equal(entry.decision, 'rejected');
      assert.equal(entry.reason, reason);
    });
  }

  test('放行路径也在调用日志里记 decision: allow', (t) => {
    const ctx = setup(t);
    runShim({}, ctx, ['task', 'create', '--title', 'x', '--project', WHITE]);

    const entries = parseCallLog(fs.readFileSync(ctx.callLog, 'utf8'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].decision, 'allow');
    assert.deepEqual(entries[0].argv, ['task', 'create', '--title', 'x', '--project', WHITE]);
  });

  // AC5 只到 decide() 不算钉住：经 spawn 也要证明 --from 或 --to 任一越界就发不出去。
  test('task move 的 --to 越界：经 spawn 也不转发', (t) => {
    const ctx = setup(t);
    const result = runShim({}, ctx, ['task', 'move', '--from', WHITE, '--to', BLACK, '--task', 't1']);

    assert.equal(fs.existsSync(ctx.marker), false, '移动请求不该发出去');
    assert.equal(result.status, 1);
    const [entry] = parseCallLog(fs.readFileSync(ctx.callLog, 'utf8'));
    assert.equal(entry.reason, 'out-of-bounds');
    assert.deepEqual(entry.targets, [BLACK]);
  });

  test('task move 的 --from 越界：经 spawn 也不转发', (t) => {
    const ctx = setup(t);
    const result = runShim({}, ctx, ['task', 'move', '--from', BLACK, '--to', WHITE, '--task', 't1']);

    assert.equal(fs.existsSync(ctx.marker), false);
    assert.equal(result.status, 1);
    assert.equal(parseCallLog(fs.readFileSync(ctx.callLog, 'utf8'))[0].reason, 'out-of-bounds');
  });

  test('task move 两端都合法：原样转发', (t) => {
    const ctx = setup(t);
    const argv = ['task', 'move', '--from', WHITE, '--to', WHITE2, '--task', 't1'];
    const result = runShim({}, ctx, argv);

    assert.deepEqual(JSON.parse(fs.readFileSync(ctx.marker, 'utf8')), argv);
    assert.equal(result.status, 0);
  });

  // AC3：agent 面对被拒时应当把它当普通 API 错误。这里钉的是可见形态——
  // 只有一行 API 错误、没有第二行内部信息，且比真 CLI 自己的失败不多任何东西。
  test('被拒时的输出形态与真 CLI 的 API 失败一致', (t) => {
    const ctx = setup(t);
    const rejected = runShim({}, ctx, ['task', 'delete', BLACK, 't1']);

    const ctx2 = setup(t);
    const failed = runShim(
      {
        FAKE_STDERR: 'DIDA API 错误 500: {"errorCode":"unknown_exception"}\n'
          + 'Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76\r\n',
        FAKE_EXIT: '1',
      },
      ctx2,
      ['task', 'delete', WHITE, 't1'],
    );

    for (const result of [rejected, failed]) {
      assert.equal(result.stdout, '', '真 CLI 的 API 错误只走 stderr');
      assert.equal(result.status, 1);
      assert.equal(result.stderr.trimEnd().split(/\r?\n/).length, 1, '只该有一行');
      assert.match(result.stderr.trimEnd(), /^DIDA API 错误 \d+: \{.*\}$/s);
    }
    assert.doesNotMatch(rejected.stderr, /shim|harness|测试清单|测试机制|guard/i);
  });
});
