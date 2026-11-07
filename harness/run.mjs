#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSandbox, SKILL_NAME } from './lib/sandbox.mjs';
import { buildSessionArgv, runSession, parseTrace, sanitizeEnv, summarizeTrace } from './lib/session.mjs';
import { defaultSettingsPath, ensureRunsDir, gitState, modelInfo, runId } from './lib/provenance.mjs';
import { listScenarios, loadScenario } from './lib/scenario.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {
    scenario: null,
    skillPath: path.join(repoRoot, 'skills', SKILL_NAME),
    settingsPath: defaultSettingsPath(),
    keepSandbox: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === '--scenario') options.scenario = next();
    else if (arg === '--skill-path') options.skillPath = path.resolve(next());
    else if (arg === '--settings') options.settingsPath = path.resolve(next());
    else if (arg === '--keep-sandbox') options.keepSandbox = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function runOne(options, id) {
  const scenario = loadScenario(repoRoot, id);
  const run = runId();
  const runsDir = ensureRunsDir(repoRoot);
  const runDir = path.join(runsDir, run);
  fs.mkdirSync(runDir, { recursive: true });

  const sandbox = createSandbox({
    runId: run,
    skillPath: options.skillPath,
    scenario,
    settingsPath: options.settingsPath,
  });

  const tracePath = path.join(runDir, 'trace.ndjson');
  const argv = buildSessionArgv({
    prompt: scenario.prompt,
    agentsPath: sandbox.agentsPath,
  });

  const env = { ...sanitizeEnv(), CLAUDE_CONFIG_DIR: sandbox.configDir };
  env.PATH = `${sandbox.binDir}${path.delimiter}${env.PATH ?? ''}`;
  const session = await runSession({ argv, cwd: sandbox.root, env, tracePath });

  const events = parseTrace(tracePath);
  const summary = summarizeTrace(events);
  const git = gitState(repoRoot);
  const sourceEnv = sandbox.anthropicEnv;

  const manifest = {
    run,
    scenario: id,
    sandbox: sandbox.root,
    skill: {
      source: options.skillPath,
      sha256: sandbox.skillFingerprint.sha256,
      files: sandbox.skillFingerprint.files,
      git,
    },
    model: { ...modelInfo(sourceEnv), requested_alias: summary.modelAlias },
    session: {
      exitCode: session.exitCode,
      timedOut: session.timedOut,
      sessionId: summary.sessionId,
      tools: summary.tools,
      turns: summary.turns,
      costUsd: summary.costUsd,
      stderr: session.stderr.slice(0, 4000),
    },
    trace: { path: tracePath, events: events.length, toolCalls: summary.toolCalls.length },
    marker: sandbox.callerMarker,
  };

  return { run, runDir, sandbox, manifest, session };
}

function writeManifest(runDir, manifest) {
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ids = options.scenario ? [options.scenario] : listScenarios(repoRoot);
  if (ids.length === 0) {
    console.error('no scenarios found');
    process.exitCode = 1;
    return;
  }

  let failures = 0;
  for (const id of ids) {
    const { run, runDir, sandbox, manifest, session } = await runOne(options, id);
    const sessionCompleted = session.exitCode === 0 && !session.timedOut;
    const retained = !sessionCompleted || options.keepSandbox;
    writeManifest(runDir, { ...manifest, sandboxRetained: retained });
    if (!retained) fs.rmSync(sandbox.root, { recursive: true, force: true });
    if (!sessionCompleted) failures += 1;
    console.log(`${sessionCompleted ? 'COMPLETED' : 'INCOMPLETE'} ${id}  run=${run}`);
    console.log(`  skill sha256=${manifest.skill.sha256.slice(0, 16)} files=${manifest.skill.files} git=${manifest.skill.git.rev?.slice(0, 12)}${manifest.skill.git.dirty ? ' (dirty)' : ''}`);
    console.log(`  model=${manifest.model.resolved_model_name ?? manifest.model.requested_alias} provider=${manifest.model.provider}`);
    console.log(`  sandbox=${sandbox.root}${retained ? ' (retained)' : ' (removed)'}`);
    console.log(`  trace=${path.relative(repoRoot, manifest.trace.path)} events=${manifest.trace.events} toolCalls=${manifest.trace.toolCalls}`);
    console.log(`  marker=${manifest.marker}`);
    console.log(`  run dir=${path.relative(repoRoot, runDir)}`);
    if (!sessionCompleted) console.log(`  session exit=${session.exitCode} timedOut=${session.timedOut}`);
  }

  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
