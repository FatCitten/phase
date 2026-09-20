#!/usr/bin/env node
/**
 * Run a bounded Pi coding task under Phase, verify, and admit to corpus.
 *
 * Usage:
 *   node scripts/run-pi-task.mjs --name "bugfix-1" --prompt "Fix the off-by-one error in src/util.mjs" --timeout 120000
 *   node scripts/run-pi-task.mjs --name "tdd-auth" --prompt "Implement auth middleware with tests" --timeout 300000
 *
 * This script:
 * 1. Launches `phase run -- pi -p <prompt>` with bounded resource flags
 * 2. Waits for completion
 * 3. Verifies the sealed run
 * 4. Optionally derives training episodes
 * 5. Reports metrics
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dir, '..');

function parseArgs(argv) {
  const args = {
    name: null,
    prompt: null,
    timeout: 180000,
    killGroup: true,
    provider: 'ollama',
    model: 'deepseek-v4-flash:0731-cloud',
    noSession: true,
    phaseHome: null,
    deriveEpisodes: true,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') { args.name = argv[++i]; continue; }
    if (a === '--prompt') { args.prompt = argv[++i]; continue; }
    if (a === '--timeout') { args.timeout = Number(argv[++i]); continue; }
    if (a === '--kill-group') { args.killGroup = true; continue; }
    if (a === '--provider') { args.provider = argv[++i]; continue; }
    if (a === '--model') { args.model = argv[++i]; continue; }
    if (a === '--no-session') { args.noSession = true; continue; }
    if (a === '--session') { args.noSession = false; continue; }
    if (a === '--phase-home') { args.phaseHome = argv[++i]; continue; }
    if (a === '--no-episodes') { args.deriveEpisodes = false; continue; }
    if (a === '--help' || a === '-h') { args.help = true; continue; }
  }
  return args;
}

function usage() {
  console.log(`Phase Pi Task Runner

Usage: node scripts/run-pi-task.mjs --name <name> --prompt <prompt> [options]

Required:
  --name <name>       Friendly name for this run (e.g., "bugfix-1", "tdd-auth")
  --prompt <text>     The task prompt to give Pi

Options:
  --timeout <ms>      Auto-terminate after N milliseconds (default: 180000)
  --kill-group        SIGKILL entire process group on timeout (default: true)
  --provider <name>   Pi provider (default: ollama)
  --model <pattern>   Pi model (default: deepseek-v4-flash:0731-cloud)
  --session           Save Pi session (default: --no-session, ephemeral)
  --phase-home <dir>  Phase home directory (default: ./.phase)
  --no-episodes       Skip episode derivation after run
  --help, -h          Show this help

Examples:
  node scripts/run-pi-task.mjs --name bugfix-util --prompt "Fix the off-by-one error in src/util.mjs" --timeout 120000
  node scripts/run-pi-task.mjs --name tdd-auth --prompt "Implement JWT auth middleware with tests" --timeout 300000
`);
}

async function runPiTask({ name, prompt, timeout, killGroup, provider, model, noSession, phaseHome }) {
  const home = resolve(phaseHome ?? join(rootDir, '.phase'));
  mkdirSync(home, { recursive: true });

  const piArgs = [
    '-p',
    '--provider', provider,
    '--model', model
  ];
  if (noSession) piArgs.push('--no-session');
  piArgs.push(prompt);

  const phaseArgs = [
    'run',
    '--name', name,
    '--timeout', String(timeout),
    killGroup ? '--kill-group' : '--no-kill-group',
    '--cwd', rootDir,
    '--'
  ];

  console.log(`[pi-task] launching: phase ${phaseArgs.join(' ')} pi ${piArgs.join(' ')}`);
  console.log(`[pi-task] phase_home=${home}`);

  return new Promise((resolve, reject) => {
    const child = spawn('phase', [...phaseArgs, 'pi', ...piArgs], {
      stdio: 'inherit',
      env: { ...process.env, PHASE_HOME: home }
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ exitCode: code, phaseHome: home });
    });
  });
}

async function findLatestRun(phaseHome) {
  const { listProcessRuns } = await import('../src/process-runtime.mjs');
  const runs = listProcessRuns(phaseHome);
  if (!runs.length) return null;
  // Sort by started_at descending
  runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  return runs[0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.name || !args.prompt) {
    usage();
    if (!args.name || !args.prompt) {
      console.error('Error: --name and --prompt are required');
      process.exit(64);
    }
    process.exit(0);
  }

  console.log(`[pi-task] === Pi Task: ${args.name} ===`);
  console.log(`[pi-task] prompt: ${args.prompt.slice(0, 120)}${args.prompt.length > 120 ? '...' : ''}`);
  console.log(`[pi-task] timeout: ${args.timeout}ms, kill-group: ${args.killGroup}`);

  // Step 1: Run Pi under Phase
  const runResult = await runPiTask(args);
  console.log(`[pi-task] Pi exited with code ${runResult.exitCode}`);

  if (runResult.exitCode !== 0) {
    console.warn(`[pi-task] Warning: Pi exited non-zero (${runResult.exitCode}). Will still attempt verification.`);
  }

  // Step 2: Find the sealed run
  console.log(`[pi-task] finding sealed run...`);
  const latest = await findLatestRun(runResult.phaseHome);
  if (!latest) {
    console.error('[pi-task] Error: no runs found');
    process.exit(1);
  }
  console.log(`[pi-task] latest run: ${latest.run_id} (${latest.name})`);

  // Step 3: Verify
  const { verifyProcessRun } = await import('../src/process-runtime.mjs');
  const v = verifyProcessRun(latest.run_dir);
  if (!v.passed) {
    console.error(`[pi-task] Verification FAILED: ${v.failures.join('; ')}`);
    process.exit(1);
  }
  console.log(`[pi-task] ✓ verified: ${v.manifest_sha256.slice(0, 16)}...`);

  // Step 4: Derive episodes (optional)
  if (args.deriveEpisodes) {
    console.log(`[pi-task] deriving training episodes...`);
    const { deriveEpisodesFromProcessRun } = await import('../src/process-episodes.mjs');
    try {
      const episodes = deriveEpisodesFromProcessRun(latest.run_dir);
      console.log(`[pi-task] ✓ derived ${episodes.length} episode(s)`);
      console.log(`[pi-task] episode measurements:`, JSON.stringify(episodes[0].measurements, null, 2));
    } catch (err) {
      console.error(`[pi-task] Episode derivation failed: ${err.message}`);
      // Non-fatal
    }
  }

  // Step 5: Summary
  const manifest = JSON.parse(readFileSync(join(latest.run_dir, 'process-manifest.json'), 'utf8'));
  const { extractProcessSignals } = await import('../src/process-episodes.mjs');
  const { readProcessEvents } = await import('../src/process-runtime.mjs');
  const events = readProcessEvents(latest.run_dir);
  const signals = extractProcessSignals(events);

  console.log(`\n[pi-task] === Summary ===`);
  console.log(`  run_id:        ${manifest.run_id}`);
  console.log(`  name:          ${manifest.name}`);
  console.log(`  exit_code:     ${manifest.exit_code}`);
  console.log(`  wall_time:     ${formatDuration(signals.wall_ms)}`);
  console.log(`  stdout:        ${formatBytes(signals.stdout_bytes)}`);
  console.log(`  stderr:        ${formatBytes(signals.stderr_bytes)}`);
  console.log(`  peak_rss:      ${formatBytes(signals.peak_rss_bytes)}`);
  console.log(`  context_misses:${signals.context_misses}`);
  console.log(`  validation:    pass=${signals.validation_passes} fail=${signals.validation_failures}`);
  console.log(`  retries:       ${signals.retries}`);
  console.log(`  artifacts:     ${signals.artifacts_emitted}`);
  console.log(`  checkpoints:   ${signals.checkpoints.length}`);
  console.log(`  sealed:        ${v.sealed}`);
  console.log(`  verified:      ${v.passed}`);

  console.log(`\n[pi-task] Next steps:`);
  console.log(`  phase logs ${manifest.run_id} -f`);
  console.log(`  phase inspect ${manifest.run_id}`);
  console.log(`  phase stats ${manifest.run_id}`);
  console.log(`  node scripts/run-pi-task.mjs --name ...  # run another task`);
}

function formatDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

main().catch(err => {
  console.error(`[pi-task] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
