import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { listProcessRuns, phaseHome, verifyProcessRun } from './process-runtime.mjs';

const sha256 = x => createHash('sha256').update(Buffer.isBuffer(x) ? x : String(x)).digest('hex');
const fileSha = p => sha256(readFileSync(p));

export function buildProcessCorpus({ home = phaseHome(), outDir = null, strict = true } = {}) {
  home = resolve(home); outDir = resolve(outDir ?? join(home, 'corpus')); mkdirSync(outDir, { recursive: true });
  const runs = [], rejected = [], skipped = [], seen = new Set();
  for (const meta of listProcessRuns(home)) {
    const dir = meta.run_dir;
    if (!existsSync(join(dir, 'SEALED'))) { skipped.push({ run_id: meta.run_id, reason: 'live-or-unsealed' }); continue; }
    const v = verifyProcessRun(dir);
    if (!v.passed) { rejected.push({ run_id: meta.run_id, dir, failures: v.failures }); continue; }
    if (seen.has(v.manifest_sha256)) continue; seen.add(v.manifest_sha256);
    const m = JSON.parse(readFileSync(join(dir, 'process-manifest.json'), 'utf8'));
    runs.push({
      schema: 'phase-process-corpus-entry-v1', run_id: m.run_id, name: m.name,
      source_rel: relative(home, dir), manifest_sha256: v.manifest_sha256,
      started_at: m.started_at, ended_at: m.ended_at, exit_code: m.exit_code, signal: m.signal,
      event_count: m.event_count, event_chain_head: m.event_chain_head,
      git: m.git, files: m.files
    });
  }
  if (strict && rejected.length) throw new Error(`corrupt sealed process runs rejected: ${JSON.stringify(rejected)}`);
  runs.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)) || a.run_id.localeCompare(b.run_id));
  const runsPath = join(outDir, 'process-runs.ndjson'); writeFileSync(runsPath, runs.map(JSON.stringify).join('\n') + (runs.length ? '\n' : ''));
  const manifest = {
    schema: 'phase-process-corpus-v1', created_at: new Date().toISOString(), source_home: home,
    runs: runs.length, skipped_live: skipped.length, rejected: rejected.length,
    files: { process_runs: { file: 'process-runs.ndjson', sha256: fileSha(runsPath) } },
    principle: 'verified sealed runs are indexed by content hash; canonical run bytes are never rewritten'
  };
  const mp = join(outDir, 'process-corpus.json'); writeFileSync(mp, `${JSON.stringify(manifest, null, 2)}\n`);
  const seal = fileSha(mp); writeFileSync(join(outDir, 'SEALED'), `${seal}  process-corpus.json\n`);
  return { ...manifest, corpus_sha256: seal, skipped_runs: skipped, rejected_runs: rejected };
}

export function verifyProcessCorpus(dir) {
  dir = resolve(dir); const failures = [], mp = join(dir, 'process-corpus.json'), sp = join(dir, 'SEALED');
  if (!existsSync(mp)) return { passed: false, dir, failures: ['missing process-corpus.json'] };
  const m = JSON.parse(readFileSync(mp, 'utf8')), digest = fileSha(mp);
  if (!existsSync(sp)) failures.push('missing SEALED');
  else if (readFileSync(sp, 'utf8').trim().split(/\s+/)[0] !== digest) failures.push('corpus seal mismatch');
  for (const meta of Object.values(m.files ?? {})) {
    const p = join(dir, meta.file); if (!existsSync(p)) failures.push(`missing ${meta.file}`); else if (fileSha(p) !== meta.sha256) failures.push(`hash mismatch ${meta.file}`);
  }
  return { passed: failures.length === 0, dir, corpus_sha256: digest, runs: m.runs, failures };
}
