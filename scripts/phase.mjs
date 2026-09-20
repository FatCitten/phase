#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { loadWorkflow, normalizeWorkflow } from '../src/phase-ir.mjs';
import { compileWorkflowDescription } from '../src/workflow-compiler.mjs';
import { runWorkflow } from '../src/fiber-runtime.mjs';
import { FiberRenderer } from '../src/fiber-ui.mjs';
import { detectAvailableAdapters } from '../src/adapters.mjs';
import { verifyResearchRun } from '../src/research.mjs';
import { verifyPhaseBin, readPhaseBin, phaseBinTail } from '../src/phasebin.mjs';
import { buildCorpus, verifyCorpus } from '../src/corpus.mjs';
import { buildProcessCorpus, verifyProcessCorpus } from '../src/process-corpus.mjs';
import { disassembleRun, loadSymbols, rawHex, replaySummary, streamName } from '../src/trace.mjs';
import { STREAM, formatPacket } from '../src/isa.mjs';
import {
  createProcessRun, eventMessage, formatBytes, formatDuration, listProcessRuns, outputBytesForEvent,
  phaseHome, readProcessEvents, resolveProcessRun, sendRunRequest, shortEventLabel, verifyProcessRun
} from '../src/process-runtime.mjs';

const VERSION = '1.1.0-beta.1';
const supervisorScript = fileURLToPath(new URL('./phase-supervisor.mjs', import.meta.url));

function usage() {
  console.log(`Phase ${VERSION} — run anything, know exactly what happened

Core
  phase run [options] -- <command> [args...]   Run any process under Phase
  phase ps                                    List runs
  phase logs [run] [-f]                       Read/follow the event log
  phase inspect [run]                         Explain one run
  phase emit <type> [key=value ...]           Add a structured event from inside a run

Control
  phase pause|resume|stop|kill [run]          Control the process group

Data
  phase verify [run|path]                     Verify a sealed run / Phase dataset
  phase export [run] --format jsonl|syslog|otel
                                                Stream a standard integration view

Research / allocator
  phase init [workflow.json] [repo]
  phase compile <description|file> [workflow.json]
  phase run <workflow.json> [--raw|--plain]   Phase-native fiber workflow (compat)
  phase trace <run-dir> [--state] [--follow]
  phase raw <run-dir|phasebin> [control|signals|state] [--hex]
  phase disasm <phasebin>
  phase replay <run-dir>
  phase corpus [out-dir]                        Build verified process-run corpus
  phase corpus --research [experiments] [out]  Build allocator research corpus
  phase train [experiments-dir] [model-dir]
  phase agents
  phase skill

Run options
  -d, --detach          Leave it running in the background
  --name NAME           Human name for the run
  --cwd DIR             Working directory for the child process
  --sample-ms N         OS resource sampling interval (default 1000ms)

Environment
  PHASE_HOME            Storage root (default: ./.phase)

Examples
  phase run -- npm test
  phase run -d --name api -- node server.js
  phase logs -f
  phase inspect
  phase stop
`);
}

function workflowTemplate(cwd) {
  return normalizeWorkflow({ id: 'project', cwd, objective: 'Describe the finished project outcome', constraints: [], decisions: [], defaults: { agent: 'auto', budget: { tokens: 24000, context_tokens: 12000, wall_ms: 900000, tool_calls: 40 } }, fibers: [{ id: 'F1', objective: 'Implement the first independently verifiable unit of work', depends_on: [], agent: 'auto', tools: ['read', 'edit', 'test'], validation: [] }] }, { baseDir: cwd });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function walkResults(p, out = []) { if (!existsSync(p)) return out; const s = statSync(p); if (s.isFile()) { if (basename(p) === 'result.json') out.push(p); return out; } for (const n of readdirSync(p)) walkResults(join(p, n), out); return out; }
function resolveBus(run, bus = 'control') { const m = { control: 'control.phasebin', ctrl: 'control.phasebin', signals: 'signals.phasebin', signal: 'signals.phasebin', sig: 'signals.phasebin', state: 'state.phasebin' }; return join(resolve(run), m[bus] ?? bus); }
function color(code, text) { return process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text; }
function parseValue(v) { if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v); if (v === 'true') return true; if (v === 'false') return false; if (v === 'null') return null; if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) { try { return JSON.parse(v); } catch {} } return v; }
function isAlive(pid) { if (!pid) return false; try { process.kill(Number(pid), 0); return true; } catch { return false; } }

function parseProcessRunArgs(args) {
  const opt = { detach: false, name: null, cwd: process.cwd(), sampleMs: 1000 };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { i++; break; }
    if (a === '-d' || a === '--detach') { opt.detach = true; continue; }
    if (a === '--name') { opt.name = args[++i]; continue; }
    if (a === '--cwd') { opt.cwd = resolve(args[++i]); continue; }
    if (a === '--sample-ms') { opt.sampleMs = Number(args[++i]); continue; }
    if (a.startsWith('-')) return { error: `unknown run option: ${a}` };
    break;
  }
  return { opt, command: args[i], commandArgs: args.slice(i + 1) };
}

async function waitForMeta(runDir, timeoutMs = 2500) {
  const p = join(runDir, 'meta.json'), start = Date.now();
  while (Date.now() - start < timeoutMs) { if (existsSync(p)) { try { const x = JSON.parse(readFileSync(p, 'utf8')); if (x.child_pid || ['failed', 'exited'].includes(x.state)) return x; } catch {} } await sleep(50); }
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

async function runProcessCommand(args) {
  const parsed = parseProcessRunArgs(args); if (parsed.error) throw new Error(parsed.error);
  const { opt, command, commandArgs } = parsed; if (!command) throw new Error('missing command; use: phase run -- <command> [args...]');
  const home = phaseHome(process.cwd());
  const { runId, runDir } = createProcessRun({ command, args: commandArgs, cwd: opt.cwd, name: opt.name, sampleMs: opt.sampleMs, home });
  const supArgs = [supervisorScript, '--run-dir', runDir]; if (!opt.detach) supArgs.push('--foreground');
  if (opt.detach) {
    const child = spawn(process.execPath, supArgs, { detached: true, stdio: 'ignore', env: process.env }); child.unref();
    const meta = await waitForMeta(runDir);
    console.log(`${color('32', '●')} ${runId}  ${meta?.state ?? 'starting'}  pid=${meta?.child_pid ?? '…'}`);
    console.log(`  logs: phase logs ${runId} -f`);
    console.log(`  data: ${runDir}`);
    return 0;
  }
  process.stderr.write(`[phase] ${runId}  ${command} ${commandArgs.join(' ')}\n`);
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, supArgs, { stdio: 'inherit', env: process.env });
    child.once('exit', c => done(c ?? 1)); child.once('error', () => done(1));
  });
  process.stderr.write(`[phase] ${runId}  ${code === 0 ? 'complete' : `exit=${code}`}  data=${runDir}\n`);
  return code;
}

function runAge(meta) {
  const start = Date.parse(meta.started_at || meta.created_at || new Date().toISOString());
  const end = meta.ended_at ? Date.parse(meta.ended_at) : Date.now(); return Math.max(0, end - start);
}
function stateGlyph(state) { return state === 'running' ? color('32', '●') : state === 'paused' ? color('33', 'Ⅱ') : state === 'exited' ? color('32', '✓') : state === 'failed' ? color('31', '✗') : color('36', '·'); }
function clip(s, n) { s = String(s ?? ''); return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`; }

function printPs() {
  const runs = listProcessRuns(); if (!runs.length) { console.log('No Phase process runs.'); return; }
  console.log(`${'RUN'.padEnd(31)} ${'STATE'.padEnd(9)} ${'PID'.padStart(7)} ${'AGE'.padStart(7)}  COMMAND`);
  for (const x of runs.slice(0, 50)) {
    let state = x.state; if (['running', 'paused', 'stopping'].includes(state) && !isAlive(x.supervisor_pid)) state = 'orphaned';
    console.log(`${clip(x.run_id, 30).padEnd(31)} ${`${stateGlyph(state)} ${state}`.padEnd(18)} ${String(x.child_pid ?? '—').padStart(7)} ${formatDuration(runAge(x)).padStart(7)}  ${clip([x.command, ...(x.args ?? [])].join(' '), 72)}`);
  }
}

function latestResource(events) { for (let i = events.length - 1; i >= 0; i--) if (events[i].type === 'resource.sample') return events[i].data; return null; }
function inspectRun(input, json = false) {
  const runDir = resolveProcessRun(input); const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')); const events = readProcessEvents(runDir); const res = latestResource(events);
  let integrity = { state: existsSync(join(runDir, 'SEALED')) ? 'sealed' : 'live', passed: null };
  if (integrity.state === 'sealed') { const v = verifyProcessRun(runDir); integrity = { state: 'sealed', passed: v.passed, failures: v.failures }; }
  const summary = { ...meta, age_ms: runAge(meta), events: events.length, stdout_bytes: existsSync(join(runDir, 'stdout.raw')) ? statSync(join(runDir, 'stdout.raw')).size : 0, stderr_bytes: existsSync(join(runDir, 'stderr.raw')) ? statSync(join(runDir, 'stderr.raw')).size : 0, resources: res, integrity };
  if (json) { console.log(JSON.stringify(summary, null, 2)); return; }
  console.log(`${stateGlyph(meta.state)} ${meta.run_id}  ${meta.name}`);
  console.log(`  state     ${meta.state}${meta.exit_code != null ? `  exit=${meta.exit_code}` : ''}${meta.signal ? `  signal=${meta.signal}` : ''}`);
  console.log(`  process   pid=${meta.child_pid ?? '—'}  pgid=${meta.pgid ?? '—'}  supervisor=${meta.supervisor_pid ?? '—'}`);
  console.log(`  command   ${meta.command} ${(meta.args ?? []).join(' ')}`.trimEnd());
  console.log(`  cwd       ${meta.cwd}`);
  console.log(`  elapsed   ${formatDuration(summary.age_ms)}`);
  if (res) console.log(`  resources rss=${formatBytes(res.rss_bytes)}  cpu=${res.cpu_ms ?? '—'}ms  io=${formatBytes(res.read_bytes)}↓/${formatBytes(res.write_bytes)}↑  procs=${res.processes ?? '—'}`);
  console.log(`  data      ${events.length} events  ${formatBytes(summary.stdout_bytes)} stdout  ${formatBytes(summary.stderr_bytes)} stderr`);
  console.log(`  integrity ${integrity.state === 'live' ? color('36', 'LIVE / UNSEALED') : integrity.passed ? color('32', 'SEALED / VERIFIED') : color('31', 'SEALED / INVALID')}`);
  console.log(`  logs      phase logs ${meta.run_id} -f`);
  console.log(`  path      ${runDir}`);
}

function eventVisible(e, opt) {
  if (!opt.all && e.type === 'resource.sample') return false;
  if (opt.type && !e.type.startsWith(opt.type)) return false;
  if (opt.stream === 'stdout' && e.type !== 'process.stdout') return false;
  if (opt.stream === 'stderr' && e.type !== 'process.stderr') return false;
  return true;
}
function parseLogsArgs(args) {
  const opt = { follow: false, json: false, all: false, type: null, stream: null, input: 'latest', withOutput: false };
  let seenInput = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]; if (a === '-f' || a === '--follow') opt.follow = true; else if (a === '--json' || a === '--ndjson') opt.json = true; else if (a === '--all') opt.all = true; else if (a === '--with-output') opt.withOutput = true; else if (a === '--type') opt.type = args[++i]; else if (a === '--stream') opt.stream = args[++i]; else if (!a.startsWith('-') && !seenInput) { opt.input = a; seenInput = true; } else throw new Error(`unknown logs argument: ${a}`);
  }
  return opt;
}
function formatHumanEvent(runDir, e) {
  const t = new Date(e.at).toTimeString().slice(0, 8); const label = shortEventLabel(e.type).padEnd(5); const msg = eventMessage(runDir, e);
  if (e.type === 'process.stdout' || e.type === 'process.stderr') {
    const prefix = e.type.endsWith('stderr') ? color('31', `${t} ${label}`) : color('90', `${t} ${label}`);
    const lines = msg.replace(/\n$/, '').split(/\r?\n/); return lines.map(line => `${prefix}  ${line}`).join('\n');
  }
  const lab = e.type === 'process.exit' ? color('33', label) : e.type.startsWith('control.') ? color('36', label) : e.type.startsWith('emit.') ? color('35', label) : label;
  return `${t} ${lab}  ${msg}`;
}
async function printLogs(args) {
  const opt = parseLogsArgs(args); const runDir = resolveProcessRun(opt.input); let emitted = 0, idle = 0;
  while (true) {
    const events = readProcessEvents(runDir); const next = events.slice(emitted); emitted = events.length;
    let shown = 0;
    for (const e of next) {
      if (!eventVisible(e, opt)) continue; shown++;
      if (opt.json) {
        if (opt.withOutput && (e.type === 'process.stdout' || e.type === 'process.stderr')) console.log(JSON.stringify({ ...e, message: eventMessage(runDir, e) }));
        else console.log(JSON.stringify(e));
      } else console.log(formatHumanEvent(runDir, e));
    }
    if (shown) idle = 0; else idle++;
    if (!opt.follow) break;
    if (existsSync(join(runDir, 'SEALED')) && idle >= 2) break;
    await sleep(150);
  }
}

async function controlRun(action, input = 'latest') {
  const runDir = resolveProcessRun(input); const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8'));
  const reply = await sendRunRequest(runDir, { action }); console.log(`${color('32', '✓')} ${action} ${meta.run_id}  ${reply.signal ?? ''}`.trimEnd());
}

async function emitEvent(args) {
  if (!args[0]) throw new Error('usage: phase emit <type> [key=value ...] [--run RUN]');
  const type = args[0]; let input = null; const data = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--run') { input = args[++i]; continue; }
    const eq = args[i].indexOf('='); if (eq < 1) throw new Error(`expected key=value, got: ${args[i]}`);
    data[args[i].slice(0, eq)] = parseValue(args[i].slice(eq + 1));
  }
  const runDir = process.env.PHASE_RUN_DIR && !input ? process.env.PHASE_RUN_DIR : resolveProcessRun(input ?? 'latest');
  const r = await sendRunRequest(runDir, { action: 'emit', type, data }); console.log(`${color('32', '✓')} event #${r.seq} ${type}`);
}

async function exportRun(args) {
  let input = 'latest', format = 'jsonl', follow = false;
  for (let i = 0; i < args.length; i++) { if (args[i] === '--format') format = args[++i]; else if (args[i] === '-f' || args[i] === '--follow') follow = true; else if (!args[i].startsWith('-')) input = args[i]; else throw new Error(`unknown export argument: ${args[i]}`); }
  const runDir = resolveProcessRun(input), meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')); let emitted = 0, idle = 0;
  const render = (e) => {
    const message = eventMessage(runDir, e).replace(/\n$/, '');
    if (format === 'jsonl') return JSON.stringify({ ...e, message });
    if (format === 'syslog') {
      const sev = e.type === 'process.stderr' || e.type === 'process.error' ? 3 : 6;
      return `<${8 + sev}>1 ${e.at} ${hostname()} phase - ${meta.run_id} [phase@32473 type="${e.type}" seq="${e.seq}"] ${message.replace(/\n/g, '\\n')}`;
    }
    if (format === 'otel') {
      const severityText = e.type === 'process.stderr' || e.type === 'process.error' ? 'ERROR' : 'INFO';
      return JSON.stringify({ timeUnixNano: String(Date.parse(e.at) * 1_000_000), severityText, body: { stringValue: message }, attributes: [{ key: 'phase.run_id', value: { stringValue: e.run_id } }, { key: 'phase.event.type', value: { stringValue: e.type } }, { key: 'phase.event.seq', value: { intValue: String(e.seq) } }] });
    }
    throw new Error(`unsupported export format: ${format}`);
  };
  while (true) {
    const events = readProcessEvents(runDir), next = events.slice(emitted); emitted = events.length;
    for (const e of next) console.log(render(e));
    if (next.length) idle = 0; else idle++;
    if (!follow || (existsSync(join(runDir, 'SEALED')) && idle >= 2)) break;
    await sleep(150);
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { usage(); process.exit(0); }
if (cmd === '--version' || cmd === '-v' || cmd === 'version') { console.log(VERSION); process.exit(0); }

try {
  if (cmd === 'run') {
    const firstNonOption = args.find(x => !x.startsWith('-'));
    const hasDelimiter = args.includes('--');
    if (!hasDelimiter && firstNonOption && existsSync(resolve(firstNonOption)) && firstNonOption.endsWith('.json')) {
      const wf = loadWorkflow(firstNonOption); const raw = args.includes('--raw'), plain = args.includes('--plain') || raw; const renderer = plain ? new FiberRenderer({ enabled: false }) : undefined; const onPacket = raw ? (p, m) => console.log(`${streamName(m.stream).padEnd(5)} ${formatPacket(p, { symbols: m.symbols })}`) : null; const r = await runWorkflow(wf, { renderer, experiment: process.env.PHASE_EXPERIMENT ?? null, onPacket }); if (plain && !raw) for (const x of r.outcomes) console.log(`${x.passed ? '✓' : '✗'} ${x.fiber_id} ${Math.round(x.wall_ms)}ms`); console.log(`\n${r.passed ? 'PASS' : 'FAIL'}  ${r.completed}/${r.fibers} fibers\nrun: ${r.run_dir}`); process.exitCode = r.passed ? 0 : 2;
    } else process.exitCode = await runProcessCommand(args);
  } else if (cmd === 'ps') printPs();
  else if (cmd === 'logs') await printLogs(args);
  else if (cmd === 'inspect' || cmd === 'status') inspectRun(args.find(x => !x.startsWith('-')) ?? 'latest', args.includes('--json'));
  else if (['pause', 'resume', 'stop', 'kill'].includes(cmd)) await controlRun(cmd, args[0] ?? 'latest');
  else if (cmd === 'emit') await emitEvent(args);
  else if (cmd === 'export') await exportRun(args);
  else if (cmd === 'init') {
    const out = resolve(args[0] ?? 'phase-workflow.json'), cwd = resolve(args[1] ?? '.'); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(workflowTemplate(cwd), null, 2)); console.log(`Wrote ${out}`);
  } else if (cmd === 'compile') {
    if (!args[0]) { usage(); process.exit(64); } const description = existsSync(resolve(args[0])) ? readFileSync(resolve(args[0]), 'utf8') : args[0]; const out = resolve(args[1] ?? 'phase-workflow.json'); const wf = await compileWorkflowDescription({ description, cwd: process.cwd(), worker: { adapter: process.env.PHASE_AGENT ?? 'auto' } }); writeFileSync(out, JSON.stringify(wf, null, 2)); console.log(`Wrote ${out}`);
  } else if (cmd === 'trace') {
    if (!args[0]) { usage(); process.exit(64); } const run = resolve(args[0]), includeState = args.includes('--state'), follow = args.includes('--follow'); if (!follow) { for (const line of disassembleRun(run, { includeState })) console.log(line); } else { const files = [['control.phasebin', STREAM.CONTROL], ['signals.phasebin', STREAM.SIGNAL], ['state.phasebin', STREAM.STATE]], pos = new Map(files.map(([f]) => [f, 0])); let idle = 0; while (true) { let emitted = 0; let symbols = {}; try { symbols = loadSymbols(run); } catch {} for (const [file, stream] of files) { if (stream === STREAM.STATE && !includeState) continue; const p = join(run, file); if (!existsSync(p)) continue; const t = phaseBinTail(p, { fromRecord: pos.get(file) ?? 0 }); pos.set(file, t.next); for (const packet of t.packets) { console.log(`${streamName(stream).padEnd(5)} ${formatPacket(packet, { symbols })}`); emitted++; } } if (emitted) idle = 0; else idle++; if (existsSync(join(run, 'SEALED')) && idle >= 2) break; await sleep(150); } }
  } else if (cmd === 'raw') {
    if (!args[0]) { usage(); process.exit(64); } let p = resolve(args[0]); if (statSync(p).isDirectory()) p = resolveBus(p, args.find((x, i) => i > 0 && !x.startsWith('--')) ?? 'control'); if (args.includes('--hex')) for (const line of rawHex(p)) console.log(line); else { const x = readPhaseBin(p); console.log(JSON.stringify(x.header, null, 2)); for (const packet of x.packets) console.log(formatPacket(packet)); }
  } else if (cmd === 'disasm') {
    if (!args[0]) { usage(); process.exit(64); } const x = readPhaseBin(resolve(args[0])); console.log(`; PHASEBIN v${x.header.version} stream=${streamName(x.header.stream)} records=${x.packets.length} sha256=${x.sha256}`); for (const p of x.packets) console.log(formatPacket(p));
  } else if (cmd === 'verify') {
    const input = args[0] ?? 'latest'; let p;
    try { p = resolveProcessRun(input); } catch { p = resolve(input); }
    let v; if (existsSync(join(p, 'process-manifest.json')) || existsSync(join(p, 'meta.json'))) v = verifyProcessRun(p); else if (statSync(p).isFile()) v = verifyPhaseBin(p); else if (existsSync(join(p, 'process-corpus.json'))) v = verifyProcessCorpus(p); else if (existsSync(join(p, 'corpus.json'))) v = verifyCorpus(p); else v = verifyResearchRun(p); console.log(JSON.stringify(v, null, 2)); process.exitCode = v.passed ? 0 : 2;
  } else if (cmd === 'replay') {
    if (!args[0]) { usage(); process.exit(64); } console.log(JSON.stringify(replaySummary(resolve(args[0])), null, 2));
  } else if (cmd === 'corpus') {
    if (args[0] === '--research') {
      const r = buildCorpus({ experimentsDir: resolve(args[1] ?? '.phase/experiments'), outDir: resolve(args[2] ?? '.phase/research-corpus'), strict: true }); console.log(JSON.stringify(r, null, 2));
    } else {
      const home = phaseHome(process.cwd()), outDir = resolve(args[0] ?? join(home, 'corpus'));
      const r = buildProcessCorpus({ home, outDir, strict: true }); console.log(JSON.stringify(r, null, 2));
    }
  } else if (cmd === 'train') {
    const experiments = resolve(args[0] ?? '.phase/experiments'), model = resolve(args[1] ?? '.phase/models/allocator'), corpus = resolve('.phase/corpus'); let r = spawnSync(process.execPath, [resolve('scripts/compile-allocator-dataset.mjs'), experiments, corpus], { stdio: 'inherit' }); if ((r.status ?? 1) !== 0) { process.exitCode = r.status ?? 1; } else { const dataset = join(corpus, 'allocator-chat.jsonl'); r = spawnSync('python3', [resolve('training/train_allocator.py'), dataset, '--output', model], { stdio: 'inherit' }); process.exitCode = r.status ?? 1; }
  } else if (cmd === 'agents') {
    for (const x of detectAvailableAdapters()) console.log(`${x.available ? '✓' : '·'} ${x.id.padEnd(10)} ${x.label}${x.executable ? `  (${x.executable})` : ''}`);
  } else if (cmd === 'skill') console.log(resolve('skills/phase/SKILL.md'));
  else { usage(); process.exit(64); }
} catch (error) {
  console.error(`phase: ${error.message}`); process.exitCode = 1;
}
