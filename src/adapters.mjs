import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

const PROMPT_TOKEN = '{prompt}';
const MODEL_TOKEN = '{model}';

const shellQuote = (s) => `'${String(s).replace(/'/g, `'"'"'`)}'`;

function expandPath(raw, baseDir = process.cwd()) {
  let s = String(raw ?? '');
  if (s === '~') s = homedir();
  else if (s.startsWith('~/')) s = resolve(homedir(), s.slice(2));
  return isAbsolute(s) ? resolve(s) : resolve(baseDir, s);
}

function commandExists(name) {
  try {
    execFileSync('sh', ['-lc', `command -v ${shellQuote(name)}`], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
}

function arr(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function strings(value) { return arr(value).map(String).filter(Boolean); }
function existingPaths(items, baseDir) { return strings(items).map((p) => expandPath(p, baseDir)).filter(existsSync); }

export const BUILTIN_ADAPTERS = {
  pi: {
    id: 'pi', label: 'Pi', detect: ['pi'],
    argv: ['pi', '-p', '--approve'], prompt: 'stdin',
    configCopy: ['~/.pi/agent'],
    notes: 'Pi print-mode worker. Phase exposes the Pi agent config read-only inside isolation.'
  },
  codex: {
    id: 'codex', label: 'Codex CLI', detect: ['codex'],
    argv: ['codex', 'exec', '--ephemeral', '--sandbox', 'workspace-write', '-'], prompt: 'stdin',
    modelArgs: ['--model', MODEL_TOKEN], configCopy: ['~/.codex'],
    notes: 'Codex non-interactive exec worker. Phase remains the outer filesystem boundary.'
  },
  claude: {
    id: 'claude', label: 'Claude Code', detect: ['claude'],
    argv: ['claude', '-p', '--no-session-persistence', '--permission-mode', 'bypassPermissions', PROMPT_TOKEN], prompt: 'argv',
    modelArgs: ['--model', MODEL_TOKEN], configCopy: ['~/.claude', '~/.claude.json'],
    notes: 'Claude Code print mode. Permission bypass is contained by the outer Phase OS sandbox when isolation is enabled.'
  },
  gemini: {
    id: 'gemini', label: 'Gemini CLI', detect: ['gemini'],
    argv: ['gemini', '--yolo', '-p', PROMPT_TOKEN], prompt: 'argv',
    modelArgs: ['--model', MODEL_TOKEN], modelInsertBefore: '-p', configCopy: ['~/.gemini'],
    notes: 'Gemini CLI headless mode. YOLO approvals are contained by the outer Phase OS sandbox when isolation is enabled.'
  },
  opencode: {
    id: 'opencode', label: 'OpenCode', detect: ['opencode'],
    argv: ['opencode', 'run', '--standalone', PROMPT_TOKEN], prompt: 'argv',
    modelArgs: ['--model', MODEL_TOKEN], configCopy: ['~/.config/opencode', '~/.local/share/opencode/auth.json'],
    notes: 'OpenCode non-interactive run mode.'
  },
  aider: {
    id: 'aider', label: 'Aider', detect: ['aider'],
    argv: ['aider', '--yes-always', '--no-auto-commits', '--message', PROMPT_TOKEN], prompt: 'argv',
    modelArgs: ['--model', MODEL_TOKEN], modelInsertBefore: '--message', configCopy: ['~/.aider.conf.yml', '~/.aider'],
    notes: 'Aider single-message scripting mode with confirmations pre-approved.'
  },
  exec: {
    id: 'exec', label: 'Generic executable', detect: [], argv: null, prompt: 'stdin',
    notes: 'Harness-agnostic argv adapter. Supply worker.argv and optional worker.prompt.'
  },
  shell: {
    id: 'shell', label: 'Custom shell worker', detect: [], command: null, prompt: 'stdin',
    notes: 'Legacy/custom shell adapter. Supply worker.command; prompt defaults to stdin.'
  }
};

export const AUTO_ADAPTER_ORDER = ['pi', 'codex', 'claude', 'gemini', 'opencode', 'aider'];

function normalizeManifest(raw, source = 'manifest') {
  if (!raw || typeof raw !== 'object') throw new Error(`${source} must contain a JSON object`);
  const invocation = raw.invocation && typeof raw.invocation === 'object' ? raw.invocation : raw;
  return {
    id: String(raw.id ?? 'external'),
    label: String(raw.label ?? raw.id ?? 'External agent'),
    detect: strings(raw.detect ?? raw.executables),
    argv: invocation.argv == null ? null : strings(invocation.argv),
    command: invocation.command == null ? null : String(invocation.command),
    prompt: String(invocation.prompt ?? raw.prompt ?? 'stdin'),
    modelArgs: strings(invocation.model_args ?? raw.model_args),
    configRead: strings(raw.config_read ?? raw.configRead),
    configCopy: strings(raw.config_copy ?? raw.configCopy),
    runtimeRead: strings(raw.runtime_read ?? raw.runtimeRead),
    env: { ...(raw.env ?? {}) },
    notes: String(raw.notes ?? `External adapter from ${source}`),
    source
  };
}

export function loadAdapterManifest(path, { baseDir = process.cwd() } = {}) {
  const manifestPath = expandPath(path, baseDir);
  return { ...normalizeManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), manifestPath), manifestPath, manifestBaseDir: dirname(manifestPath) };
}

export function detectAvailableAdapters() {
  return AUTO_ADAPTER_ORDER.map((id) => {
    const a = BUILTIN_ADAPTERS[id];
    const executable = a.detect.find(commandExists) ?? null;
    return { id, label: a.label, available: Boolean(executable), executable };
  });
}

function autoAdapterId() {
  const forced = String(process.env.PHASE_AGENT ?? '').trim().toLowerCase();
  if (forced) {
    if (!BUILTIN_ADAPTERS[forced]) throw new Error(`PHASE_AGENT=${forced} is not a built-in adapter`);
    return forced;
  }
  const hit = detectAvailableAdapters().find((x) => x.available);
  if (!hit) throw new Error(`no supported coding-agent CLI detected; install one or use worker.adapter="exec"/"shell"/worker.manifest`);
  return hit.id;
}

function withModel(argv, modelArgs, model, insertBefore = null) {
  const out = [...argv];
  if (!model || !modelArgs?.length) return out;
  const extra = modelArgs.map((x) => x === MODEL_TOKEN ? String(model) : x.replaceAll(MODEL_TOKEN, String(model)));
  let at = insertBefore ? out.indexOf(insertBefore) : out.findIndex((x) => x.includes(PROMPT_TOKEN));
  if (at < 0 && out.at(-1) === '-') at = out.length - 1;
  if (at < 0) at = out.length;
  out.splice(at, 0, ...extra);
  return out;
}

function validatePromptMode(mode) {
  if (!['stdin', 'argv', 'none'].includes(mode)) throw new Error(`worker prompt mode must be stdin, argv, or none (got ${mode})`);
  return mode;
}

export function resolveWorkerAdapter(worker = {}, { baseDir = process.cwd() } = {}) {
  let base;
  if (worker.manifest) base = loadAdapterManifest(worker.manifest, { baseDir });
  else {
    let id = String(worker.adapter ?? (worker.argv ? 'exec' : worker.command ? 'shell' : 'auto')).toLowerCase();
    if (id === 'auto') id = autoAdapterId();
    base = BUILTIN_ADAPTERS[id];
    if (!base) throw new Error(`unknown worker adapter ${id}; use auto, ${Object.keys(BUILTIN_ADAPTERS).join(', ')}, or worker.manifest`);
  }

  const id = String(worker.id ?? base.id);
  const model = worker.model ?? null;
  const prompt = validatePromptMode(String(worker.prompt ?? base.prompt ?? 'stdin').toLowerCase());
  const argv0 = worker.argv == null ? base.argv : strings(worker.argv);
  const command = worker.command == null ? base.command : String(worker.command);
  if (argv0 && command) throw new Error(`worker adapter ${id} cannot define both argv and command`);
  if (!argv0 && !command) throw new Error(`worker adapter ${id} requires worker.argv or worker.command`);

  const argv = argv0 ? withModel(argv0, base.modelArgs ?? [], model, base.modelInsertBefore ?? null) : null;
  const tokenCount = (argv ?? []).filter((x) => x.includes(PROMPT_TOKEN)).length + (command?.includes(PROMPT_TOKEN) ? 1 : 0);
  if (prompt === 'argv' && tokenCount === 0) {
    if (argv) argv.push(PROMPT_TOKEN);
    else throw new Error(`shell adapter ${id} with prompt=argv must include ${PROMPT_TOKEN} in worker.command`);
  }

  const pathBase = base.manifestBaseDir ?? baseDir;
  const configRead = existingPaths([...(base.configRead ?? []), ...strings(worker.config_read ?? worker.configRead)], pathBase);
  const configCopy = existingPaths([...(base.configCopy ?? []), ...strings(worker.config_copy ?? worker.configCopy)], pathBase);
  const runtimeRead = existingPaths([...(base.runtimeRead ?? []), ...strings(worker.runtime_read ?? worker.runtimeRead)], pathBase);
  return {
    id,
    label: worker.label ?? base.label ?? id,
    argv,
    command: command?.trim() || null,
    prompt,
    env: { ...(base.env ?? {}), ...(worker.env ?? {}) },
    model,
    isolationReadPaths: [...new Set([...configRead, ...runtimeRead])],
    isolationCopyPaths: [...new Set(configCopy)],
    metadata: {
      notes: base.notes ?? null,
      source: base.manifestPath ?? base.source ?? 'builtin',
      detect: base.detect ?? [],
      ...(worker.metadata ?? {})
    }
  };
}

export function compileWorkerInvocation(adapter, promptText) {
  const prompt = String(promptText ?? '');
  let stdin = adapter.prompt === 'stdin' ? prompt : '';
  if (adapter.argv) {
    const argv = adapter.argv.map((x) => x.replaceAll(PROMPT_TOKEN, prompt));
    return { file: argv[0], args: argv.slice(1), stdin, display: argv.map(shellQuote).join(' ') };
  }
  let command = String(adapter.command ?? '');
  if (adapter.prompt === 'argv') command = command.replaceAll(PROMPT_TOKEN, shellQuote(prompt));
  return { file: 'bash', args: ['-lc', command], stdin, display: command };
}

export function workerAdapterSummary(adapter) {
  const raw = adapter.argv ? adapter.argv.join(' ') : adapter.command;
  return {
    id: adapter.id,
    label: adapter.label,
    model: adapter.model,
    prompt: adapter.prompt,
    invocation: String(raw ?? '').replace(/(?:sk-|key=|token=)[^\s]+/gi, '[redacted]'),
    source: adapter.metadata?.source ?? 'builtin'
  };
}

export { shellQuote, PROMPT_TOKEN };
