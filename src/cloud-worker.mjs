import { spawn } from 'node:child_process';
import { compileWorkerInvocation, resolveWorkerAdapter } from './adapters.mjs';
import { createIsolatedInvocation } from './worker-isolation.mjs';

function clip(text, max = 12000) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}\n...[truncated]`;
}

export async function runCloudWorker({
  cwd,
  prompt,
  adapter = null,
  command = process.env.PHASE_CLOUD_COMMAND,
  timeoutMs = Number(process.env.PHASE_CLOUD_TIMEOUT_MS ?? 600000),
  extraEnv = {},
  isolation = null
} = {}) {
  const worker = adapter ?? resolveWorkerAdapter(command ? { adapter: 'shell', command } : {});
  const compiled = compileWorkerInvocation(worker, prompt);
  const started = performance.now();
  const env = { ...process.env, ...worker.env, ...extraEnv, PHASE_ROLE: 'worker', PHASE_CONTROLLER_ACTIVE: '1', PHASE_AGENT_ADAPTER: worker.id };
  let isolated = null;
  if (isolation?.enabled) {
    isolated = createIsolatedInvocation({
      cwd,
      command: compiled.display,
      readPaths: [...(worker.isolationReadPaths ?? []), ...(isolation.readPaths ?? [])],
      copyPaths: [...(worker.isolationCopyPaths ?? []), ...(isolation.copyPaths ?? [])],
      protectedPaths: isolation.protectedPaths ?? [],
      env,
      required: isolation.required !== false
    });
  }
  const file = isolated?.file ?? compiled.file;
  const args = isolated?.args ?? compiled.args;
  const spawnCwd = isolated?.cwd ?? cwd;
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: spawnCwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => stdout += c);
    child.stderr.on('data', (c) => stderr += c);
    child.on('error', (error) => { isolated?.cleanup?.(); reject(error); });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      isolated?.cleanup?.();
      resolve({
        ok: code === 0,
        code: code ?? 1,
        signal,
        stdout: clip(stdout),
        stderr: clip(stderr),
        latencyMs: performance.now() - started,
        adapter: worker.id,
        isolation: isolated?.metadata ?? { enabled: false, backend: null, failClosed: false }
      });
    });
    child.stdin.end(compiled.stdin);
  });
}
