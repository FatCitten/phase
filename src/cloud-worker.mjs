import { spawn } from 'node:child_process';

function clip(text, max = 12000) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}\n...[truncated]`;
}

export async function runCloudWorker({ cwd, prompt, command = process.env.PHASE_CLOUD_COMMAND, timeoutMs = Number(process.env.PHASE_CLOUD_TIMEOUT_MS ?? 600000), extraEnv = {} } = {}) {
  if (!command) throw new Error('PHASE_CLOUD_COMMAND is required (example: pi -p --approve)');
  const started = performance.now();
  return await new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: { ...process.env, ...extraEnv, PHASE_ROLE: 'worker', PHASE_CONTROLLER_ACTIVE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => stdout += c);
    child.stderr.on('data', (c) => stderr += c);
    child.on('error', reject);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code: code ?? 1,
        signal,
        stdout: clip(stdout),
        stderr: clip(stderr),
        latencyMs: performance.now() - started
      });
    });
    child.stdin.end(String(prompt ?? ''));
  });
}
