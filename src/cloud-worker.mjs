import { spawn } from 'node:child_process';
import { createIsolatedInvocation } from './worker-isolation.mjs';

function clip(text, max = 12000) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}\n...[truncated]`;
}

export async function runCloudWorker({
  cwd,
  prompt,
  command = process.env.PHASE_CLOUD_COMMAND,
  timeoutMs = Number(process.env.PHASE_CLOUD_TIMEOUT_MS ?? 600000),
  extraEnv = {},
  isolation = null
} = {}) {
  if (!command) throw new Error('PHASE_CLOUD_COMMAND is required (example: pi -p --approve)');
  const started = performance.now();
  const env = { ...process.env, ...extraEnv, PHASE_ROLE: 'worker', PHASE_CONTROLLER_ACTIVE: '1' };
  let invocation = null;
  if (isolation?.enabled) {
    invocation = createIsolatedInvocation({
      cwd,
      command,
      readPaths: isolation.readPaths ?? [],
      protectedPaths: isolation.protectedPaths ?? [],
      env,
      required: isolation.required !== false
    });
  }
  const file = invocation?.file ?? 'bash';
  const args = invocation?.args ?? ['-lc', command];
  const spawnCwd = invocation?.cwd ?? cwd;
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: spawnCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => stdout += c);
    child.stderr.on('data', (c) => stderr += c);
    child.on('error', (error) => { invocation?.cleanup?.(); reject(error); });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      invocation?.cleanup?.();
      resolve({
        ok: code === 0,
        code: code ?? 1,
        signal,
        stdout: clip(stdout),
        stderr: clip(stderr),
        latencyMs: performance.now() - started,
        isolation: invocation?.metadata ?? { enabled: false, backend: null, failClosed: false }
      });
    });
    child.stdin.end(String(prompt ?? ''));
  });
}
