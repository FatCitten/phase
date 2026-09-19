import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const FULL_ACCESS = 'rw';
const READ_ACCESS = 'ro';

function commandPath(name) {
  try {
    return execFileSync('sh', ['-lc', `command -v ${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

function canonical(path) {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

function inside(path, root) {
  const p = canonical(path), r = canonical(root);
  return p === r || p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

function uniqExisting(paths) {
  const out = [];
  const seen = new Set();
  for (const raw of paths ?? []) {
    if (!raw) continue;
    const p = resolve(String(raw));
    if (!existsSync(p) || seen.has(p)) continue;
    seen.add(p); out.push(p);
  }
  return out;
}

function firstExecutable(command) {
  let s = String(command ?? '').trim();
  while (true) {
    const assignment = s.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s]+)\s+/);
    if (!assignment) break;
    s = s.slice(assignment[0].length);
  }
  const match = s.match(/^(?:'([^']+)'|"([^"]+)"|([^\s;&|()]+))/);
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

function executableSupportPaths(command, env = process.env) {
  const paths = [];
  for (const entry of String(env.PATH ?? '').split(':').filter(Boolean)) if (isAbsolute(entry)) paths.push(entry);
  const token = firstExecutable(command);
  if (token && /^[A-Za-z0-9_./+:-]+$/.test(token)) {
    try {
      const located = token.includes('/') ? canonical(token) : execFileSync('sh', ['-lc', `command -v ${token}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (located) paths.push(dirname(canonical(located)));
    } catch {}
  }
  return paths;
}

export function defaultIsolationReadPaths(command, env = process.env) {
  const system = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group', '/etc/ssl', '/etc/ca-certificates', '/etc/pki'];
  return uniqExisting([...system, ...executableSupportPaths(command, env)]);
}

export function probeWorkerIsolation() {
  if (process.platform !== 'linux') return { available: false, backend: 'linux-chroot', reason: 'requires Linux' };
  for (const name of ['unshare', 'mount', 'chroot', 'setpriv', 'sh']) {
    if (!commandPath(name)) return { available: false, backend: 'linux-chroot', reason: `missing required command: ${name}` };
  }
  const probe = spawnSync('unshare', ['--user', '--map-root-user', '--mount', '--fork', 'sh', '-c', 'mount --make-rprivate /'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  if (probe.status !== 0) return { available: false, backend: 'linux-chroot', reason: (probe.stderr || probe.stdout || 'user/mount namespaces unavailable').trim() };
  return { available: true, backend: 'linux-chroot', reason: null };
}

export function buildIsolationPlan({ cwd, command, readPaths = [], copyPaths = [], protectedPaths = [], env = process.env } = {}) {
  cwd = canonical(cwd ?? process.cwd());
  const ro = uniqExisting([...defaultIsolationReadPaths(command, env), ...(readPaths ?? [])]).filter((p) => !inside(p, cwd));
  if (ro.some((p) => p === '/')) throw new Error('Phase isolation refuses to expose host root read-only');
  const copied = uniqExisting(copyPaths ?? []).filter((p) => !inside(p, cwd));
  const protectedResolved = uniqExisting(protectedPaths ?? []);
  for (const secret of protectedResolved) {
    if (inside(secret, cwd)) continue;
    const exposing = [...ro, ...copied].find((root) => inside(secret, root));
    if (exposing) throw new Error(`isolation read/copy path would expose protected evaluator asset: ${exposing}`);
  }
  return { backend: 'linux-chroot', cwd, readPaths: ro, copyPaths: copied, protectedCount: protectedResolved.length };
}

const SETUP = `
set -eu
ROOT=$1
CWD=$2
COMMAND=$3
HOST_HOME=\${HOME:-/tmp/phase-home}
shift 3
mount --make-rprivate /
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs "$ROOT"
mkdir -p "$ROOT/tmp" "$ROOT$HOST_HOME" "$ROOT/dev" "$ROOT/proc"
chmod 1777 "$ROOT/tmp"

bind_one() {
  mode=$1
  src=$2
  dst="$ROOT$src"
  if [ "$mode" = copy ]; then
    mkdir -p "$(dirname "$dst")"
    if [ -d "$src" ]; then
      mkdir -p "$dst"
      cp -a "$src/." "$dst/"
    else
      cp -a "$src" "$dst"
    fi
    return
  fi
  if [ -d "$src" ]; then
    mkdir -p "$dst"
  else
    mkdir -p "$(dirname "$dst")"
    : > "$dst"
  fi
  mount --bind "$src" "$dst"
  if [ "$mode" = ro ]; then
    mount -o remount,bind,ro,nosuid,nodev "$dst"
  fi
}

for spec in "$@"; do
  mode=\${spec%%:*}
  src=\${spec#*:}
  bind_one "$mode" "$src"
done

for dev in null zero random urandom; do
  if [ -e "/dev/$dev" ]; then
    : > "$ROOT/dev/$dev"
    mount --bind "/dev/$dev" "$ROOT/dev/$dev"
  fi
done

export HOME="$HOST_HOME"
export TMPDIR=/tmp
export PHASE_SANDBOX=linux-chroot
export PHASE_SANDBOX_CWD="$CWD"
export PHASE_SANDBOX_COMMAND="$COMMAND"

exec chroot "$ROOT" /usr/bin/setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs /bin/bash -c 'cd "$PHASE_SANDBOX_CWD"; exec /bin/bash -lc "$PHASE_SANDBOX_COMMAND"'
`;

export function createIsolatedInvocation({ cwd, command, readPaths = [], copyPaths = [], protectedPaths = [], env = process.env, required = true } = {}) {
  const probe = probeWorkerIsolation();
  if (!probe.available) {
    if (required) throw new Error(`Phase worker isolation unavailable: ${probe.reason}`);
    return null;
  }
  const plan = buildIsolationPlan({ cwd, command, readPaths, copyPaths, protectedPaths, env });
  const root = mkdtempSync(join(tmpdir(), 'phase-worker-root-'));
  const specs = [`${FULL_ACCESS}:${plan.cwd}`, ...plan.readPaths.map((p) => `${READ_ACCESS}:${p}`), ...plan.copyPaths.map((p) => `copy:${p}`)];
  return {
    file: 'unshare',
    args: ['--user', '--map-root-user', '--mount', '--fork', '--kill-child', 'sh', '-ceu', SETUP, 'phase-isolation', root, plan.cwd, String(command), ...specs],
    cwd: plan.cwd,
    cleanup: () => { try { rmSync(root, { recursive: true, force: true }); } catch {} },
    metadata: { enabled: true, backend: plan.backend, failClosed: Boolean(required), protectedCount: plan.protectedCount, copiedConfigPaths: plan.copyPaths.length }
  };
}
