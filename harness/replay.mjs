#!/usr/bin/env node
// 回放验证：拿一次**历史运行**的 calls.ndjson 喂给这条 scenario 的断言模块，
// 回答「这条断言在真实日志上到底是什么结论」。不跑会话、不烧 API。
//
// 用途是复现价：写断言模块时，探针取样应当让结局断言变绿、过程断言变红。
// 后者若在取样上也是绿，说明规则抓不到真实发生过的动作——要么规则写错了，
// 要么那条缺陷不会再复现。两种都得先知道，再决定要不要留。
//
// 只读：不写 manifest、不动清场。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAssert, loadProcessAssert } from './lib/assertion.mjs';
import { parseCallLog } from './lib/calllog.mjs';
import { loadScenario } from './lib/scenario.mjs';
import { formatValue } from './lib/report.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { scenario: null, run: null };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${argv[i - 1]}`);
      return argv[i];
    };
    if (argv[i] === '--scenario') options.scenario = next();
    else if (argv[i] === '--run') options.run = next();
    else if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

const USAGE = `用法：
  node harness/replay.mjs --scenario <id> --run <runId>

  --scenario <id>  要回放的用例（决定用哪份 assert.mjs / process.mjs）
  --run <runId>    一次历史运行，读 runs/<runId>/calls.ndjson 与 state.json
                   runId 可以只给前缀，命中唯一一条即可

只读这次运行的事实，不跑会话、不改清场。结局断言读 state.json 里的终态快照，
过程断言读 calls.ndjson——与真跑时的输入同源。`;

// runId 允许给前缀：真跑出来的 id 很长，手输总是截断。
export function resolveRun(runsDir, wanted) {
  if (!fs.existsSync(runsDir)) throw new Error(`runs 目录不存在：${runsDir}`);
  const all = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const hits = all.filter((name) => name === wanted);
  const prefixed = all.filter((name) => name.startsWith(wanted));
  const matches = hits.length > 0 ? hits : prefixed;
  if (matches.length === 0) throw new Error(`找不到 run：${wanted}`);
  if (matches.length > 1) throw new Error(`run 前缀 ${wanted} 命中 ${matches.length} 条，写全一点：${matches.join('、')}`);
  return path.join(runsDir, matches[0]);
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (!options.scenario || !options.run) throw new Error('--scenario 与 --run 都必填');

  const scenario = loadScenario(repoRoot, options.scenario);
  const runDir = resolveRun(path.join(repoRoot, 'runs'), options.run);
  const runId = path.basename(runDir);

  const callLogPath = path.join(runDir, 'calls.ndjson');
  const calls = fs.existsSync(callLogPath) ? parseCallLog(fs.readFileSync(callLogPath, 'utf8')) : [];
  const state = readJson(path.join(runDir, 'state.json'));

  console.log(`回放 ${options.scenario}  run=${runId}`);
  console.log(`  calls=${calls.length} 条  state=${state === null ? '缺失' : `${state.length} 条`}`);

  const assertFn = await loadAssert(scenario.dir);
  const processFn = await loadProcessAssert(scenario.dir);

  if (assertFn) {
    if (state === null) {
      console.log('  结局断言：跳过（这次运行没有 state.json，前一面就停了）');
    } else {
      const results = await assertFn({ tasks: state, calls, created: [], session: {} });
      report('结局断言', results);
    }
  } else {
    console.log('  结局断言：跳过（这条用例没有 assert.mjs）');
  }

  if (processFn) {
    const results = await processFn({ calls });
    report('过程断言', results);
  } else {
    console.log('  过程断言：跳过（这条用例没有 process.mjs）');
  }
}

function report(label, results) {
  if (!Array.isArray(results)) {
    console.log(`  ${label}：模块没返回数组（${typeof results}）`);
    process.exitCode = 1;
    return;
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`  ${label}：${results.length - failed.length}/${results.length} 通过`);
  for (const result of failed) {
    console.log(`    ✗ ${result.name}：期望 ${formatValue(result.expected)}，实际 ${formatValue(result.actual)}`);
  }
  if (failed.length > 0) process.exitCode = 1;
}

// 作为模块被测试 import 时不要执行；只有直接运行时才进 CLI（与 run.mjs 同口径）。
if (import.meta.main) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
