import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync, writeSync
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { gitSnapshot, stableJson } from './util.mjs';

const sha256 = (x) => createHash('sha256').update(Buffer.isBuffer(x) ? x : String(x)).digest('hex');
const fileSha = (p) => sha256(readFileSync(p));

export function phaseHome(cwd = process.cwd()) {
  return resolve(process.env.PHASE_HOME || join(cwd, '.phase'));
}

export function makeRunId() {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:]/g, '').replace('T', '_').replace(/\..+/, '');
  return `run_${stamp}_${randomBytes(3).toString('hex')}`;
}

export function runRoot(home = phaseHome()) { return join(resolve(home), 'runs'); }
export function runDirFor(id, home = phaseHome()) { return join(runRoot(home), id); }

function atomicJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export class ProcessEventLog {
  constructor(runDir, runId) {
    this.runDir = resolve(runDir);
    this.runId = runId;
    this.path = join(this.runDir, 'events.ndjson');
    if (!existsSync(this.path)) writeFileSync(this.path, '');
    this.seq = 0;
    this.prev = '0'.repeat(64);
    this.startNs = process.hrtime.bigint();
  }
  append(type, data = {}, source = 'phase') {
    const body = {
      schema: 'phase-process-event-v1',
      run_id: this.runId,
      seq: ++this.seq,
      at: new Date().toISOString(),
      mono_ns: String(process.hrtime.bigint() - this.startNs),
      type,
      source,
      data,
      prev_sha256: this.prev
    };
    const row = { ...body, sha256: sha256(stableJson(body)) };
    this.prev = row.sha256;
    appendFileSync(this.path, `${JSON.stringify(row)}\n`);
    return row;
  }
}

class RawCapture {
  constructor(path, streamName, log, tee = null) {
    this.path = path;
    this.streamName = streamName;
    this.log = log;
    this.tee = tee;
    this.fd = openSync(path, 'w');
    this.offset = 0;
  }
  write(chunk) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    writeSync(this.fd, b, 0, b.length, this.offset);
    const at = this.offset;
    this.offset += b.length;
    this.log.append(`process.${this.streamName}`, {
      offset: at,
      bytes: b.length,
      sha256: sha256(b)
    }, `process.${this.streamName}`);
    if (this.tee) this.tee.write(b);
  }
  close() { try { closeSync(this.fd); } catch {} }
}

function getconf(name, fallback) {
  try {
    const x = Number(spawnSync('getconf', [name], { encoding: 'utf8' }).stdout.trim());
    return Number.isFinite(x) && x > 0 ? x : fallback;
  } catch { return fallback; }
}

const CLK_TCK = process.platform === 'linux' ? getconf('CLK_TCK', 100) : 100;
const PAGE_SIZE = process.platform === 'linux' ? getconf('PAGESIZE', 4096) : 4096;

function procStat(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = text.lastIndexOf(')');
    if (close < 0) return null;
    const head = text.slice(0, text.indexOf(' '));
    const rest = text.slice(close + 2).trim().split(/\s+/);
    return {
      pid: Number(head), state: rest[0], ppid: Number(rest[1]), pgrp: Number(rest[2]),
      utime: Number(rest[11]), stime: Number(rest[12]), rssPages: Number(rest[21])
    };
  } catch { return null; }
}

function procIo(pid) {
  try {
    const out = {};
    for (const line of readFileSync(`/proc/${pid}/io`, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([^:]+):\s*(\d+)$/);
      if (m) out[m[1]] = Number(m[2]);
    }
    return { readBytes: out.read_bytes ?? null, writeBytes: out.write_bytes ?? null };
  } catch { return { readBytes: null, writeBytes: null }; }
}

export function sampleProcessGroup(pgid) {
  if (process.platform !== 'linux') return {
    processes: null, cpu_ms: null, user_cpu_ms: null, system_cpu_ms: null,
    rss_bytes: null, read_bytes: null, write_bytes: null
  };
  let userTicks = 0, systemTicks = 0, rssPages = 0, readBytes = 0, writeBytes = 0, processes = 0;
  let readObserved = false, writeObserved = false;
  let names = [];
  try { names = readdirSync('/proc').filter(x => /^\d+$/.test(x)); } catch { names = [String(pgid)]; }
  for (const name of names) {
    const s = procStat(Number(name));
    if (!s || s.pgrp !== Number(pgid)) continue;
    processes++;
    userTicks += s.utime || 0; systemTicks += s.stime || 0; rssPages += Math.max(0, s.rssPages || 0);
    const io = procIo(s.pid);
    if (io.readBytes != null) { readObserved = true; readBytes += io.readBytes; }
    if (io.writeBytes != null) { writeObserved = true; writeBytes += io.writeBytes; }
  }
  const userMs = userTicks * 1000 / CLK_TCK, systemMs = systemTicks * 1000 / CLK_TCK;
  return {
    processes,
    cpu_ms: Math.round((userMs + systemMs) * 1000) / 1000,
    user_cpu_ms: Math.round(userMs * 1000) / 1000,
    system_cpu_ms: Math.round(systemMs * 1000) / 1000,
    rss_bytes: rssPages * PAGE_SIZE,
    read_bytes: readObserved ? readBytes : null,
    write_bytes: writeObserved ? writeBytes : null
  };
}

export function socketPathFor(runDir, runId) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\phase-${runId}` : join(resolve(runDir), 'control.sock');
}

function signalGroup(pid, signal) {
  if (!pid) throw new Error('run has no child process');
  if (process.platform !== 'win32') process.kill(-Number(pid), signal);
  else process.kill(Number(pid), signal);
}

function controlSignal(action) {
  return ({ pause: 'SIGSTOP', resume: 'SIGCONT', stop: 'SIGTERM', kill: 'SIGKILL', interrupt: 'SIGINT' })[action] ?? null;
}

function startControlServer({ socketPath, log, state, metaPath }) {
  if (process.platform !== 'win32') try { unlinkSync(socketPath); } catch {}
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let req;
        try { req = JSON.parse(line); } catch { sock.write(`${JSON.stringify({ ok: false, error: 'invalid json' })}\n`); continue; }
        try {
          if (req.action === 'emit') {
            const row = log.append(`emit.${String(req.type || 'event')}`, req.data ?? {}, 'external');
            sock.write(`${JSON.stringify({ ok: true, seq: row.seq })}\n`);
            continue;
          }
          if (req.action === 'status') { sock.write(`${JSON.stringify({ ok: true, state })}\n`); continue; }
          const sig = controlSignal(req.action);
          if (!sig) throw new Error(`unsupported action: ${req.action}`);
          log.append('control.request', { action: req.action, signal: sig, requester_pid: req.requester_pid ?? null });
          signalGroup(state.child_pid, sig);
          if (req.action === 'pause') state.state = 'paused';
          if (req.action === 'resume') state.state = 'running';
          if (req.action === 'stop' || req.action === 'kill' || req.action === 'interrupt') state.state = 'stopping';
          atomicJson(metaPath, state);
          sock.write(`${JSON.stringify({ ok: true, action: req.action, signal: sig })}\n`);
        } catch (error) { sock.write(`${JSON.stringify({ ok: false, error: error.message })}\n`); }
      }
    });
  });
  server.listen(socketPath, () => { if (process.platform !== 'win32') try { chmodSync(socketPath, 0o600); } catch {} });
  return server;
}

export async function superviseProcess({ runDir, foreground = false } = {}) {
  runDir = resolve(runDir);
  const commandPath = join(runDir, 'command.json');
  const spec = JSON.parse(readFileSync(commandPath, 'utf8'));
  const runId = spec.run_id;
  const log = new ProcessEventLog(runDir, runId);
  const metaPath = join(runDir, 'meta.json');
  const socketPath = socketPathFor(runDir, runId);
  const state = {
    schema: 'phase-process-meta-v1', run_id: runId, name: spec.name, state: 'starting',
    command: spec.command, args: spec.args, cwd: spec.cwd, created_at: spec.created_at,
    started_at: null, ended_at: null, supervisor_pid: process.pid, child_pid: null, pgid: null,
    exit_code: null, signal: null, run_dir: runDir, socket: socketPath
  };
  atomicJson(metaPath, state);
  const server = startControlServer({ socketPath, log, state, metaPath });
  log.append('run.start', { name: spec.name, command: spec.command, args: spec.args, cwd: spec.cwd, sample_ms: spec.sample_ms });

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, PHASE_RUN_ID: runId, PHASE_RUN_DIR: runDir, PHASE_SOCKET: socketPath, PHASE_HOME: spec.phase_home },
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });
  state.child_pid = child.pid; state.pgid = child.pid; state.state = 'running'; state.started_at = new Date().toISOString();
  atomicJson(metaPath, state);
  log.append('process.spawn', { pid: child.pid, pgid: child.pid, command: spec.command });

  const out = new RawCapture(join(runDir, 'stdout.raw'), 'stdout', log, foreground ? process.stdout : null);
  const err = new RawCapture(join(runDir, 'stderr.raw'), 'stderr', log, foreground ? process.stderr : null);
  child.stdout.on('data', x => out.write(x)); child.stderr.on('data', x => err.write(x));

  const sample = () => {
    const s = sampleProcessGroup(child.pid);
    log.append('resource.sample', s, 'os');
    state.resources = s;
    const peak = state.resource_peak ?? { rss_bytes: null, processes: null };
    if (s.rss_bytes != null) peak.rss_bytes = Math.max(Number(peak.rss_bytes ?? 0), Number(s.rss_bytes));
    if (s.processes != null) peak.processes = Math.max(Number(peak.processes ?? 0), Number(s.processes));
    state.resource_peak = peak;
    atomicJson(metaPath, state);
  };
  sample();
  const timer = setInterval(sample, Math.max(250, Number(spec.sample_ms ?? 1000)));
  timer.unref?.();

  const relay = (signal) => {
    try { log.append('control.parent_signal', { signal }); signalGroup(child.pid, signal); } catch {}
  };
  const onInt = () => relay('SIGINT'), onTerm = () => relay('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);

  const result = await new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveResult({ code, signal }));
  }).catch((error) => ({ error }));

  clearInterval(timer); process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  out.close(); err.close();
  if (result.error) {
    state.state = 'failed'; state.ended_at = new Date().toISOString();
    log.append('process.error', { message: result.error.message, code: result.error.code ?? null });
  } else {
    state.exit_code = result.code; state.signal = result.signal; state.ended_at = new Date().toISOString();
    state.state = result.code === 0 ? 'exited' : 'failed';
    log.append('process.exit', { code: result.code, signal: result.signal });
  }
  atomicJson(metaPath, state);
  await new Promise(r => server.close(r));
  if (process.platform !== 'win32') try { unlinkSync(socketPath); } catch {}
  sealProcessRun(runDir, { state, event_head: log.prev, event_count: log.seq });
  return { ...state, exit_code: state.exit_code ?? 1 };
}

export function createProcessRun({ command, args = [], cwd = process.cwd(), name = null, sampleMs = 1000, home = phaseHome(cwd) }) {
  cwd = resolve(cwd); home = resolve(home); mkdirSync(runRoot(home), { recursive: true, mode: 0o700 });
  const runId = makeRunId(); const runDir = runDirFor(runId, home); mkdirSync(runDir, { recursive: false, mode: 0o700 });
  const spec = {
    schema: 'phase-process-command-v1', run_id: runId, created_at: new Date().toISOString(),
    name: name || basename(command), command, args: args.map(String), cwd, sample_ms: Number(sampleMs), phase_home: home
  };
  writeFileSync(join(runDir, 'command.json'), `${JSON.stringify(spec, null, 2)}\n`);
  atomicJson(join(runDir, 'meta.json'), {
    schema: 'phase-process-meta-v1', run_id: runId, name: spec.name, state: 'created',
    command: spec.command, args: spec.args, cwd: spec.cwd, created_at: spec.created_at,
    started_at: null, ended_at: null, supervisor_pid: null, child_pid: null, pgid: null,
    exit_code: null, signal: null, run_dir: runDir, socket: socketPathFor(runDir, runId)
  });
  return { runId, runDir, spec };
}

export function sealProcessRun(runDir, { state, event_head, event_count }) {
  runDir = resolve(runDir);
  const files = {};
  for (const file of ['command.json', 'events.ndjson', 'stdout.raw', 'stderr.raw']) {
    const p = join(runDir, file);
    if (!existsSync(p)) continue;
    files[file] = { sha256: fileSha(p), bytes: statSync(p).size };
  }
  const manifest = {
    schema: 'phase-process-run-v1', run_id: state.run_id, name: state.name,
    started_at: state.started_at, ended_at: state.ended_at, exit_code: state.exit_code, signal: state.signal,
    host: hostname(), node: process.version, platform: process.platform, arch: process.arch,
    git: gitSnapshot(state.cwd), event_count, event_chain_head: event_head, files,
    principle: 'raw process bytes and append-only measured events are canonical; views are derived'
  };
  const p = join(runDir, 'process-manifest.json'); writeFileSync(p, `${JSON.stringify(manifest, null, 2)}\n`);
  const digest = fileSha(p); writeFileSync(join(runDir, 'SEALED'), `${digest}  process-manifest.json\n`);
  return { manifest, digest };
}

export function verifyProcessEventLog(path) {
  const failures = []; let prev = '0'.repeat(64), seq = 0;
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of rows) {
    let row; try { row = JSON.parse(line); } catch { failures.push(`invalid json at event ${seq + 1}`); continue; }
    const got = row.sha256; const { sha256: _omit, ...body } = row;
    seq++;
    if (row.seq !== seq) failures.push(`sequence mismatch at ${seq}: got ${row.seq}`);
    if (row.prev_sha256 !== prev) failures.push(`previous hash mismatch at ${seq}`);
    const expected = sha256(stableJson(body)); if (got !== expected) failures.push(`event hash mismatch at ${seq}`);
    prev = got;
  }
  return { passed: failures.length === 0, events: rows.length, head: prev, failures };
}

export function verifyProcessRun(runDir) {
  runDir = resolve(runDir); const failures = [];
  const mp = join(runDir, 'process-manifest.json'), seal = join(runDir, 'SEALED');
  if (!existsSync(mp)) return { passed: false, sealed: false, run_dir: runDir, failures: ['run is not sealed'] };
  const manifest = JSON.parse(readFileSync(mp, 'utf8')); const digest = fileSha(mp);
  if (!existsSync(seal)) failures.push('missing SEALED');
  else if (readFileSync(seal, 'utf8').trim().split(/\s+/)[0] !== digest) failures.push('manifest seal mismatch');
  for (const [file, meta] of Object.entries(manifest.files ?? {})) {
    const p = join(runDir, file); if (!existsSync(p)) failures.push(`missing ${file}`);
    else { if (fileSha(p) !== meta.sha256) failures.push(`hash mismatch ${file}`); if (statSync(p).size !== meta.bytes) failures.push(`size mismatch ${file}`); }
  }
  const ev = verifyProcessEventLog(join(runDir, 'events.ndjson'));
  if (!ev.passed) failures.push(...ev.failures);
  if (ev.head !== manifest.event_chain_head) failures.push('event chain head mismatch');
  if (ev.events !== manifest.event_count) failures.push('event count mismatch');
  return { passed: failures.length === 0, sealed: true, run_dir: runDir, run_id: manifest.run_id, manifest_sha256: digest, events: ev.events, failures };
}

export function listProcessRuns(home = phaseHome()) {
  const root = runRoot(home); if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name), metaPath = join(dir, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try { out.push({ ...JSON.parse(readFileSync(metaPath, 'utf8')), run_dir: dir }); } catch {}
  }
  return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function resolveProcessRun(input = 'latest', home = phaseHome()) {
  const p = input && input !== 'latest' ? resolve(input) : null;
  if (p && existsSync(join(p, 'meta.json'))) return p;
  const runs = listProcessRuns(home);
  if (!runs.length) throw new Error(`no Phase process runs under ${runRoot(home)}`);
  if (!input || input === 'latest') return runs[0].run_dir;
  const hit = runs.find(x => x.run_id === input || x.run_id.startsWith(input));
  if (!hit) throw new Error(`run not found: ${input}`);
  return hit.run_dir;
}

export function readProcessEvents(runDir) {
  const p = join(resolve(runDir), 'events.ndjson'); if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

export function outputBytesForEvent(runDir, event) {
  if (event.type !== 'process.stdout' && event.type !== 'process.stderr') return null;
  const file = event.type.endsWith('stdout') ? 'stdout.raw' : 'stderr.raw';
  const p = join(resolve(runDir), file); if (!existsSync(p)) return null;
  const all = readFileSync(p); return all.subarray(Number(event.data.offset), Number(event.data.offset) + Number(event.data.bytes));
}

export async function sendRunRequest(runDir, req, { timeoutMs = 2000 } = {}) {
  runDir = resolve(runDir); const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8'));
  const socketPath = meta.socket || socketPathFor(runDir, meta.run_id);
  return await new Promise((resolveReply, reject) => {
    const sock = net.createConnection(socketPath); let buf = ''; const timer = setTimeout(() => { sock.destroy(); reject(new Error('Phase control request timed out')); }, timeoutMs);
    sock.setEncoding('utf8'); sock.on('error', e => { clearTimeout(timer); reject(e); });
    sock.on('connect', () => sock.write(`${JSON.stringify({ ...req, requester_pid: process.pid })}\n`));
    sock.on('data', chunk => { buf += chunk; const i = buf.indexOf('\n'); if (i < 0) return; clearTimeout(timer); sock.end(); const x = JSON.parse(buf.slice(0, i)); x.ok ? resolveReply(x) : reject(new Error(x.error || 'Phase control request failed')); });
  });
}

export function formatBytes(n) {
  if (n == null) return '—'; let x = Number(n); const units = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (Math.abs(x) >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x >= 10 || i === 0 ? x.toFixed(0) : x.toFixed(1)}${units[i]}`;
}

export function formatDuration(ms) {
  if (ms == null) return '—'; ms = Math.max(0, Number(ms));
  if (ms < 1000) return `${Math.round(ms)}ms`; const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`; const m = Math.floor(s / 60), rs = Math.round(s % 60);
  return `${m}m${String(rs).padStart(2, '0')}s`;
}

export function eventMessage(runDir, event) {
  if (event.type === 'process.stdout' || event.type === 'process.stderr') {
    const b = outputBytesForEvent(runDir, event); return b ? b.toString('utf8') : '';
  }
  if (event.type === 'run.start') return `${event.data.name} → ${event.data.command} ${(event.data.args ?? []).join(' ')}`.trim();
  if (event.type === 'process.spawn') return `pid=${event.data.pid} pgid=${event.data.pgid}`;
  if (event.type === 'process.exit') return `code=${event.data.code ?? '—'} signal=${event.data.signal ?? '—'}`;
  if (event.type === 'process.error') return event.data.message ?? 'process error';
  if (event.type === 'resource.sample') return `cpu=${event.data.cpu_ms ?? '—'}ms rss=${formatBytes(event.data.rss_bytes)} procs=${event.data.processes ?? '—'}`;
  if (event.type === 'control.request') return `${event.data.action} (${event.data.signal})`;
  if (event.type.startsWith('emit.')) return Object.entries(event.data ?? {}).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
  return Object.entries(event.data ?? {}).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
}

export function shortEventLabel(type) {
  if (type === 'process.stdout') return 'OUT'; if (type === 'process.stderr') return 'ERR';
  if (type === 'run.start') return 'RUN'; if (type === 'process.spawn') return 'PROC'; if (type === 'process.exit') return 'EXIT';
  if (type === 'resource.sample') return 'RES'; if (type.startsWith('control.')) return 'CTRL'; if (type.startsWith('emit.')) return 'EVENT';
  return type.toUpperCase().slice(0, 8);
}
