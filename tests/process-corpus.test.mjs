import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProcessCorpus, verifyProcessCorpus } from '../src/process-corpus.mjs';
import { createProcessRun, superviseProcess } from '../src/process-runtime.mjs';

test('process corpus admits only verified sealed runs and seals its index', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phase-corpus-')), home = join(root, '.phase');
  const good = createProcessRun({ command: process.execPath, args: ['-e', 'console.log("ok")'], cwd: process.cwd(), home });
  await superviseProcess({ runDir: good.runDir });
  createProcessRun({ command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 99999)'], cwd: process.cwd(), home }); // unsealed: skipped
  const corpus = buildProcessCorpus({ home, outDir: join(root, 'corpus') });
  assert.equal(corpus.runs, 1);
  assert.equal(corpus.skipped_live, 1);
  assert.equal(corpus.rejected, 0);
  assert.equal(verifyProcessCorpus(join(root, 'corpus')).passed, true);
});

test('process corpus rejects a corrupt sealed run in strict mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phase-corpus-bad-')), home = join(root, '.phase');
  const run = createProcessRun({ command: process.execPath, args: ['-e', 'console.log("ok")'], cwd: process.cwd(), home });
  await superviseProcess({ runDir: run.runDir });
  writeFileSync(join(run.runDir, 'stdout.raw'), 'tampered\n');
  assert.throws(() => buildProcessCorpus({ home, outDir: join(root, 'corpus'), strict: true }), /corrupt sealed process runs rejected/);
});
