#!/usr/bin/env node
/**
 * Derive Phase TPM allocation episodes from sealed process runs.
 *
 * A process run (events.ndjson from phase run -- <command>) is converted into
 * one or more (state, allocation, outcome) tuples suitable for training the
 * Phase TPM allocator.
 *
 * The conversion is intentionally conservative:
 * - Only sealed, verified runs are admitted.
 * - State is derived from measurable signals (context misses, failures, retries, wall time).
 * - Allocation is reconstructed from the initial fiber budget (heuristic baseline).
 * - Outcome is the measured validation result + resource consumption.
 *
 * This module does NOT invent measurements. Missing signals remain null.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyProcessRun, readProcessEvents } from './process-runtime.mjs';
import { encodeAllocationState } from './phase-features.mjs';
import { PHASE_ARCHITECTURE_SEED, seedHash } from './phase-seeds.mjs';
import { allocationToAssembly } from './allocator.mjs';

const sha256 = x => createHash('sha256').update(Buffer.isBuffer(x) ? x : String(x)).digest('hex');

/**
 * Extract structured signals from a process run's event stream.
 * Returns measurable quantities only; no fabrication.
 */
export function extractProcessSignals(events) {
  const signals = {
    wall_ms: null,
    exit_code: null,
    signal: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
    context_misses: 0,
    validation_failures: 0,
    validation_passes: 0,
    retries: 0,
    human_interventions: 0,
    artifacts_emitted: 0,
    checkpoints: [],
    blockers: [],
    decisions: []
  };

  let peak_rss_bytes = 0, total_cpu_ms = 0;

  for (const e of events) {
    // Process lifecycle
    if (e.type === 'process.exit') {
      signals.exit_code = e.data.exit_code;
      signals.signal = e.data.signal;
    }
    if (e.type === 'process.stdout') {
      signals.stdout_bytes += Number(e.data.bytes ?? 0);
    }
    if (e.type === 'process.stderr') {
      signals.stderr_bytes += Number(e.data.bytes ?? 0);
    }
    if (e.type === 'resource.sample') {
      const rss = Number(e.data.rss_bytes ?? 0);
      if (rss > peak_rss_bytes) peak_rss_bytes = rss;
      const cpu = Number(e.data.cpu_ms ?? 0);
      if (cpu > total_cpu_ms) total_cpu_ms = cpu;
    }
    // Agent/structured emits
    if (e.type?.startsWith('emit.')) {
      const kind = e.type.replace('emit.', '');
      const d = e.data ?? {};
      if (kind === 'context_miss') signals.context_misses++;
      if (kind === 'validation' && d.status === 'fail') signals.validation_failures++;
      if (kind === 'validation' && d.status === 'pass') signals.validation_passes++;
      if (kind === 'retry') signals.retries++;
      if (kind === 'human' || kind === 'decision' && d.source === 'human') signals.human_interventions++;
      if (kind === 'artifact') signals.artifacts_emitted++;
      if (kind === 'checkpoint') signals.checkpoints.push(d);
      if (kind === 'blocker') signals.blockers.push(d);
      if (kind === 'decision') signals.decisions.push(d);
    }
  }

  // Wall time from first to last event
  const timestamps = events.map(e => new Date(e.timestamp).getTime()).filter(Number.isFinite);
  if (timestamps.length >= 2) {
    signals.wall_ms = Math.max(0, Math.max(...timestamps) - Math.min(...timestamps));
  }

  signals.peak_rss_bytes = peak_rss_bytes;
  signals.total_cpu_ms = total_cpu_ms;

  return signals;
}

/**
 * Reconstruct a baseline allocation from the process run metadata + signals.
 * This uses the heuristic allocator logic: allocate a reasonable budget
 * based on observed consumption + reserve fractions.
 */
export function reconstructAllocation(signals, commandMeta) {
  const seed = PHASE_ARCHITECTURE_SEED;
  const observedTokens = Math.ceil((signals.stdout_bytes + signals.stderr_bytes) / 4); // rough char→token
  const contextCeiling = Math.max(4096, Math.ceil(observedTokens * 2)); // 2x observed
  const contextAlloc = Math.round(contextCeiling * seed.priors.initial_context_fraction);
  const wallCeiling = signals.wall_ms ? Math.ceil(signals.wall_ms * 1.5) : 300000;
  const toolCalls = 1 + Math.floor(signals.artifacts_emitted / 2) + signals.retries;

  return {
    schema: 'phase-allocation-v1',
    agent: 'pi', // default; could be inferred from command
    tools: ['read', 'bash', 'edit', 'write'],
    budget: {
      context_tokens: contextAlloc,
      tokens: Math.max(2048, observedTokens),
      wall_ms: wallCeiling,
      tool_calls: Math.max(4, toolCalls),
      money_microunits: 0,
      human_attention_microunits: signals.human_interventions > 0 ? 1000000 : 0
    },
    reserve: {
      fraction: seed.priors.reserve_fraction,
      repair_fraction: seed.priors.repair_reserve_fraction
    },
    seed_hash: seedHash(seed),
    policy: 'heuristic-reconstructed'
  };
}

/**
 * Build a state vector for a process run.
 * Uses the same encoding as the fiber-based allocator, adapted for process signals.
 */
export function buildProcessStateVector(signals, commandMeta, dimensions = 96) {
  // Synthesize a minimal "workflow/fiber/runtime" object compatible with encodeAllocationState
  const workflow = {
    cwd: commandMeta.cwd || process.cwd(),
    objective: commandMeta.name || commandMeta.command || 'process-task'
  };
  const fiber = {
    id: commandMeta.run_id || 'proc-1',
    agent: 'pi',
    tools: ['read', 'bash', 'edit', 'write'],
    depends_on: [],
    budget: {
      context_tokens: 16384,
      tokens: 8192,
      wall_ms: 300000,
      tool_calls: 20
    }
  };
  const runtime = {
    progress: signals.validation_passes > 0 ? 1 : 0,
    validation_failures: signals.validation_failures,
    context_misses: signals.context_misses,
    attempts: 1 + signals.retries
  };

  return encodeAllocationState({ workflow, fiber, runtime, dimensions });
}

/**
 * Convert a single sealed process run into one or more allocation episodes.
 * Returns an array of episode objects matching the schema expected by the training pipeline.
 */
export function deriveEpisodesFromProcessRun(runDir) {
  runDir = resolve(runDir);
  const verification = verifyProcessRun(runDir);
  if (!verification.passed) {
    throw new Error(`invalid process run ${runDir}: ${verification.failures.join('; ')}`);
  }

  const manifest = JSON.parse(readFileSync(join(runDir, 'process-manifest.json'), 'utf8'));
  const events = readProcessEvents(runDir);
  const signals = extractProcessSignals(events);
  const allocation = reconstructAllocation(signals, manifest);
  const stateVector = buildProcessStateVector(signals, manifest);

  const episode = {
    schema: 'phase-process-allocation-episode-v1',
    source: 'canonical-process-run',
    source_manifest_sha256: verification.manifest_sha256,
    run_id: manifest.run_id,
    name: manifest.name,
    command: { command: manifest.command, args: manifest.args, cwd: manifest.cwd },
    state_vector: stateVector.vector,
    state_dimensions: stateVector.dimensions,
    repository_id: stateVector.repository_id,
    allocation: {
      agent: allocation.agent,
      tools: allocation.tools,
      budget: allocation.budget
    },
    control_isa: allocationToAssembly(allocation),
    measurements: {
      wall_ms: signals.wall_ms,
      exit_code: signals.exit_code,
      signal: signals.signal,
      stdout_bytes: signals.stdout_bytes,
      stderr_bytes: signals.stderr_bytes,
      peak_rss_bytes: signals.peak_rss_bytes,
      total_cpu_ms: signals.total_cpu_ms,
      validation_passed: signals.validation_passes > 0 ? (signals.validation_failures === 0 ? 1 : 0) : null,
      validation_failures: signals.validation_failures,
      context_misses: signals.context_misses,
      retries: signals.retries,
      human_interventions: signals.human_interventions,
      artifacts_emitted: signals.artifacts_emitted,
      checkpoints_count: signals.checkpoints.length,
      blockers_count: signals.blockers.length
    },
    emitted_events: {
      checkpoints: signals.checkpoints,
      blockers: signals.blockers,
      decisions: signals.decisions
    }
  };

  return [episode];
}

/**
 * Build a training dataset (allocator-chat.jsonl format) from sealed process runs.
 * This is the bridge between process runtime and the TPM training pipeline.
 */
export async function buildProcessTrainingDataset({ home, outDir, strict = true } = {}) {
  const { listProcessRuns, phaseHome } = await import('./process-runtime.mjs');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const { PHASE_ARCHITECTURE_SEED, seedSystemPrompt } = await import('./phase-seeds.mjs');

  home = resolve(home ?? phaseHome());
  outDir = resolve(outDir ?? join(home, 'corpus'));
  mkdirSync(outDir, { recursive: true });

  const episodes = [];
  const rejected = [];
  const skipped = [];
  const seen = new Set();

  for (const meta of listProcessRuns(home)) {
    const dir = meta.run_dir;
    if (!existsSync(join(dir, 'SEALED'))) {
      skipped.push({ run_id: meta.run_id, reason: 'live-or-unsealed' });
      continue;
    }
    const v = verifyProcessRun(dir);
    if (!v.passed) {
      rejected.push({ run_id: meta.run_id, dir, failures: v.failures });
      continue;
    }
    if (seen.has(v.manifest_sha256)) continue;
    seen.add(v.manifest_sha256);

    try {
      const eps = deriveEpisodesFromProcessRun(dir);
      episodes.push(...eps);
    } catch (err) {
      rejected.push({ run_id: meta.run_id, dir, error: String(err.message || err) });
    }
  }

  if (strict && rejected.length) {
    throw new Error(`failed to derive episodes from ${rejected.length} runs: ${JSON.stringify(rejected.slice(0, 3))}`);
  }

  // Build chat-format dataset for SFT
  const seed = PHASE_ARCHITECTURE_SEED;
  const rows = episodes.map((e, i) => ({
    id: `proc-alloc-${i + 1}`,
    source_manifest_sha256: e.source_manifest_sha256,
    messages: [
      {
        role: 'system',
        content: seedSystemPrompt(seed)
      },
      {
        role: 'user',
        content: JSON.stringify({
          state_vector: e.state_vector,
          measurement_context: e.measurements
        })
      },
      {
        role: 'assistant',
        content: e.control_isa
      }
    ]
  }));

  const chatPath = join(outDir, 'process-allocator-chat.jsonl');
  writeFileSync(chatPath, rows.map(JSON.stringify).join('\n') + (rows.length ? '\n' : ''));

  const manifest = {
    schema: 'phase-process-training-dataset-v1',
    created_at: new Date().toISOString(),
    source_home: home,
    episodes: episodes.length,
    skipped_live: skipped.length,
    rejected: rejected.length,
    files: {
      chat: { file: 'process-allocator-chat.jsonl', examples: rows.length }
    },
    principle: 'derived from sealed process runs; canonical bytes unchanged'
  };

  const mp = join(outDir, 'process-training-view.json');
  writeFileSync(mp, JSON.stringify(manifest, null, 2) + '\n');

  return { ...manifest, episodes, skipped_runs: skipped, rejected_runs: rejected };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(`Usage: node src/process-episodes.mjs [home-dir] [out-dir]
Build a TPM training dataset from sealed process runs.

home-dir: Phase home (default: ./.phase)
out-dir:  Output corpus directory (default: <home>/corpus)

Example:
  node src/process-episodes.mjs .phase .phase/corpus
`);
    process.exit(0);
  }

  const home = resolve(args[0] ?? '.phase');
  const outDir = resolve(args[1] ?? join(home, 'corpus'));

  try {
    const result = await buildProcessTrainingDataset({ home, outDir });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
