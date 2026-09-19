const shellQuote = (s) => `'${String(s).replace(/'/g, `'"'"'`)}'`;

export const BUILTIN_ADAPTERS = {
  pi: {
    id: 'pi',
    label: 'Pi',
    command: 'pi -p --approve',
    notes: 'Project-local Pi worker in print mode.'
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    // Explicit workspace-write sandbox is the current non-interactive automation path.
    command: 'codex exec --sandbox workspace-write -',
    notes: 'Codex non-interactive worker with repository write access.'
  },
  shell: {
    id: 'shell',
    label: 'Custom shell worker',
    command: null,
    notes: 'Supply worker.command in the harness config.'
  }
};

export function resolveWorkerAdapter(worker = {}) {
  const id = String(worker.adapter ?? 'shell').toLowerCase();
  const base = BUILTIN_ADAPTERS[id];
  if (!base) throw new Error(`unknown worker adapter ${id}; use ${Object.keys(BUILTIN_ADAPTERS).join(', ')}`);
  const command = String(worker.command ?? base.command ?? '').trim();
  if (!command) throw new Error(`worker adapter ${id} requires worker.command`);
  return {
    id,
    label: worker.label ?? base.label,
    command,
    env: { ...(worker.env ?? {}) },
    model: worker.model ?? null,
    metadata: { notes: base.notes, ...(worker.metadata ?? {}) }
  };
}

export function workerAdapterSummary(adapter) {
  return {
    id: adapter.id,
    label: adapter.label,
    model: adapter.model,
    command: adapter.command.replace(/(?:sk-|key=|token=)[^\s]+/gi, '[redacted]')
  };
}

export { shellQuote };
