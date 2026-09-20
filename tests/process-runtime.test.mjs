import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProcessRun, readProcessEvents, sendRunRequest, superviseProcess,
  verifyProcessRun
} from '../src/process-runtime.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeout = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const x = fn(); if (x) return x; await delay(25);
  }
  throw new Error('timed out');
}

test('process runtime preserves byte-exact stdout/stderr and seals an append-only event log', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phase-proc-'));
  const { runDir } = createProcessRun({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("hello\\n"); process.stderr.write("warn\\n")'],
    cwd: process.cwd(),
    home: join(root, '.phase'),
    sampleMs: 250
  });
  const result = await superviseProcess({ runDir, foreground: false });
  assert.equal(result.exit_code, 0);
  assert.equal(readFileSync(join(runDir, 'stdout.raw'), 'utf8'), 'hello\n');
  assert.equal(readFileSync(join(runDir, 'stderr.raw'), 'utf8'), 'warn\n');
  const events = readProcessEvents(runDir);
  assert.ok(events.some(x => x.type === 'process.spawn'));
  assert.ok(events.some(x => x.type === 'process.stdout'));
  assert.ok(events.some(x => x.type === 'process.stderr'));
  assert.ok(events.some(x => x.type === 'process.exit'));
  const verified = verifyProcessRun(runDir);
  assert.equal(verified.passed, true, JSON.stringify(verified.failures));
});

test('tampering with captured process bytes invalidates the sealed run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phase-tamper-'));
  const { runDir } = createProcessRun({
    command: process.execPath, args: ['-e', 'console.log("clean")'], cwd: process.cwd(), home: join(root, '.phase')
  });
  await superviseProcess({ runDir, foreground: false });
  writeFileSync(join(runDir, 'stdout.raw'), 'dirty\n');
  const verified = verifyProcessRun(runDir);
  assert.equal(verified.passed, false);
  assert.ok(verified.failures.some(x => x.includes('stdout.raw')));
});

test('live control socket records external events and controls the process group', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phase-control-'));
  const { runDir } = createProcessRun({
    command: process.execPath,
    args: ['-e', 'setInterval(()=>console.log("tick"), 50)'],
    cwd: process.cwd(), home: join(root, '.phase'), sampleMs: 250
  });
  const running = superviseProcess({ runDir, foreground: false });
  await waitFor(() => {
    try { return JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')).child_pid; } catch { return null; }
  });
  await sendRunRequest(runDir, { action: 'emit', type: 'checkpoint', data: { step: 2, ok: true } });
  await sendRunRequest(runDir, { action: 'pause' });
  await delay(75);
  await sendRunRequest(runDir, { action: 'resume' });
  await sendRunRequest(runDir, { action: 'stop' });
  const result = await running;
  assert.equal(result.signal, 'SIGTERM');
  const events = readProcessEvents(runDir);
  assert.ok(events.some(x => x.type === 'emit.checkpoint' && x.data.step === 2));
  assert.deepEqual(events.filter(x => x.type === 'control.request').map(x => x.data.action), ['pause', 'resume', 'stop']);
  assert.equal(verifyProcessRun(runDir).passed, true);
});
