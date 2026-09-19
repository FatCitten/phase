import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { resolveWorkerAdapter } from './adapters.mjs';

function arr(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }
function strCommands(items) {
  return arr(items).map((x) => Array.isArray(x) ? x.map(String) : String(x)).filter((x) => Array.isArray(x) ? x.length : x.trim());
}
function normalizeCopies(items = []) {
  return arr(items).map((x) => {
    if (!x || typeof x !== 'object' || !x.from || !x.to) throw new Error('hidden.install entries require {from,to}');
    return { from: String(x.from), to: String(x.to) };
  });
}

export function loadHarnessConfig(path) {
  const configPath = resolve(path);
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  const cwd = resolve(raw.cwd ?? '.');
  const task = String(raw.task ?? raw.prompt ?? '').trim();
  if (!task) throw new Error('harness config requires task');
  const worker = resolveWorkerAdapter(raw.worker ?? (raw.cloud_command ? { adapter: 'shell', command: raw.cloud_command } : {}), { baseDir: dirname(configPath) });
  const publicCommands = strCommands(raw.verify?.public ?? raw.public_validation_commands ?? raw.public_validation_command);
  const hiddenCommands = strCommands(raw.verify?.hidden ?? raw.hidden_validation_commands ?? raw.validation_commands);
  const hiddenCopies = normalizeCopies(raw.hidden?.install ?? raw.hidden_copies ?? []);
  const hiddenPaths = arr(raw.hidden?.paths ?? raw.hidden_paths).map(String);
  const denyPatterns = arr(raw.hidden?.deny ?? raw.deny_patterns).map(String);
  const referencePaths = arr(raw.hidden?.reference ?? raw.reference_paths).map(String);
  const id = String(raw.id ?? `phase-${Date.now()}`);
  const hiddenConfigured = hiddenCopies.length > 0 || hiddenPaths.length > 0 || hiddenCommands.length > 0;
  const isolationEnabled = raw.isolation?.enabled ?? true;
  const isolationRequired = raw.isolation?.required ?? hiddenConfigured;
  const isolationReadPaths = [...new Set([...worker.isolationReadPaths, ...arr(raw.isolation?.read ?? raw.isolation?.read_paths).map((p) => resolve(String(p)))])];
  const isolationCopyPaths = [...new Set([...worker.isolationCopyPaths, ...arr(raw.isolation?.copy ?? raw.isolation?.copy_paths).map((p) => resolve(String(p)))])];
  const cloudTelemetry = String(raw.cloud?.telemetry ?? 'metrics');
  const cloudDataProduct = String(raw.cloud?.data_product ?? 'none');
  if (!['off','metrics','trace'].includes(cloudTelemetry)) throw new Error('cloud.telemetry must be off, metrics, or trace');
  if (!['none','aggregate'].includes(cloudDataProduct)) throw new Error('cloud.data_product must be none or aggregate');
  return {
    id, configPath, cwd, task, worker,
    publicCommands,
    hiddenCommands,
    hiddenCopies,
    hiddenPaths,
    denyPatterns,
    referencePaths,
    isolationEnabled: Boolean(isolationEnabled),
    isolationRequired: Boolean(isolationRequired),
    isolationReadPaths,
    isolationCopyPaths,
    policy: String(raw.governor?.policy ?? raw.policy ?? 'heuristic'),
    maxSteps: Number(raw.governor?.max_steps ?? raw.max_steps ?? 12),
    maxRepairs: Number(raw.governor?.max_repairs ?? raw.max_repairs ?? 2),
    stopOnFailure: raw.verify?.stop_on_failure ?? raw.stop_on_failure ?? true,
    allowConfigInWorktree: Boolean(raw.allow_config_in_worktree),
    brainDb: raw.storage?.brain_db ? resolve(raw.storage.brain_db) : raw.brain_db ? resolve(raw.brain_db) : null,
    phaseIndex: raw.storage?.phase_index ? resolve(raw.storage.phase_index) : raw.phase_index ? resolve(raw.phase_index) : null,
    exportFullTrace: Boolean(raw.training?.export_full_private_trace ?? false),
    trainingEnabled: raw.training?.enabled !== false,
    reportEnabled: raw.report?.enabled !== false,
    reportTitle: String(raw.report?.title ?? task),
    cloud: {
      enabled: Boolean(raw.cloud?.enabled ?? false),
      url: raw.cloud?.url ? String(raw.cloud.url) : null,
      required: Boolean(raw.cloud?.required ?? false),
      apiKey: raw.cloud?.api_key ? String(raw.cloud.api_key) : null,
      apiKeyEnv: String(raw.cloud?.api_key_env ?? 'PHASE_CLOUD_API_KEY'),
      account: raw.cloud?.account ? String(raw.cloud.account) : null,
      telemetry: String(raw.cloud?.telemetry ?? 'metrics'),
      dataProduct: String(raw.cloud?.data_product ?? 'none'),
      timeoutMs: Number(raw.cloud?.timeout_ms ?? 5000)
    },
    tags: arr(raw.tags).map(String),
    raw
  };
}

export function validateHarnessBoundary(cfg) {
  const prefix = cfg.cwd.endsWith('/') ? cfg.cwd : `${cfg.cwd}/`;
  if ((cfg.configPath === cfg.cwd || cfg.configPath.startsWith(prefix)) && !cfg.allowConfigInWorktree) {
    throw new Error('Phase harness config must live outside the agent worktree unless allow_config_in_worktree=true');
  }
  for (const item of cfg.hiddenCopies) {
    const from = resolve(item.from);
    if (from === cfg.cwd || from.startsWith(prefix)) throw new Error(`hidden source must live outside worktree: ${from}`);
  }
  for (const raw of cfg.hiddenPaths) {
    const p = isAbsolute(raw) ? raw : resolve(cfg.cwd, raw);
    if (!p.startsWith(prefix)) continue;
    // Existence is checked immediately before the agent starts by the runner.
  }
  return true;
}

export function publicValidationShell(cfg) {
  if (!cfg.publicCommands.length) return null;
  return cfg.publicCommands.map((c) => Array.isArray(c) ? c.map(shellPart).join(' ') : `(${c})`).join(' && ');
}
function shellPart(s) { return /^[A-Za-z0-9_./:@=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`; }
