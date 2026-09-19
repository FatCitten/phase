import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BrainStore } from './store.mjs';
import { loadPhaseIndexForStore } from './phase-index.mjs';
import { retrieveClaims } from './retrieval.mjs';
import { claimFreshness } from './freshness.mjs';
import { runCloudWorker } from './cloud-worker.mjs';
import { gitSnapshot, redactSecrets, sha256 } from './util.mjs';

export const REPO_BEHAVIORS = ['inspect', 'delegate', 'validate', 'repair', 'review', 'consolidate', 'finish'];

function run(cwd, argv) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { argv, status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function git(cwd, args) { try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } }
function clip(s, max = 8000) { s = String(s ?? ''); return s.length <= max ? s : `${s.slice(0, max)}\n...[truncated]`; }

function memoryText(claims) {
  if (!claims.length) return '(none)';
  return claims.map(c => `${c.public_id} [${claimFreshness(c).status}] ${c.claim}`).join('\n');
}

export function detectValidation(cwd) {
  if (process.env.PHASE_VALIDATE_COMMAND) return ['bash', '-lc', process.env.PHASE_VALIDATE_COMMAND];
  const pkg = join(cwd, 'package.json');
  if (existsSync(pkg)) {
    try {
      const scripts = JSON.parse(readFileSync(pkg, 'utf8')).scripts ?? {};
      for (const name of ['test', 'check', 'lint', 'typecheck']) if (scripts[name]) return ['npm', 'run', name, '--', '--runInBand'];
    } catch {}
  }
  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'tests'))) return ['python', '-m', 'pytest', '-q'];
  if (existsSync(join(cwd, 'Cargo.toml'))) return ['cargo', 'test', '--quiet'];
  if (existsSync(join(cwd, 'go.mod'))) return ['go', 'test', './...'];
  return null;
}

export function inspectRepository(cwd, task, store, phaseIndex) {
  const files = git(cwd, ['ls-files']).split('\n').filter(Boolean).slice(0, 300);
  const status = git(cwd, ['status', '--short']);
  const retrieval = retrieveClaims(store, task, 8, phaseIndex, process.env.PHASE_RETRIEVAL ?? 'hybrid', cwd);
  const validation = detectValidation(cwd);
  return {
    git: gitSnapshot(cwd),
    status,
    files,
    validation,
    memories: memoryText(retrieval.claims),
    retrievalBackend: retrieval.backend
  };
}

export function heuristicBehavior(state) {
  if (!state.inspected) return 'inspect';
  if (state.workerRuns === 0) return 'delegate';
  if (!state.validationAttempted) return 'validate';
  if (!state.validationPassed && state.repairs < state.maxRepairs) return 'repair';
  if (!state.validationPassed) return 'finish';
  if (!state.reviewed) return 'review';
  if (!state.consolidated) return 'consolidate';
  return 'finish';
}

async function callBehaviorModel({ state, baseUrl, model, timeoutMs = 60000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${String(baseUrl).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.PHASE_CONTROLLER_API_KEY ?? 'no-key'}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 32,
        messages: [
          { role: 'system', content: `You are Phase Repo Governor. Choose exactly one repository-management behavior from: ${REPO_BEHAVIORS.join(', ')}. You do not write code. Return only JSON {"behavior":"..."}.` },
          { role: 'user', content: JSON.stringify(state) }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`controller model ${response.status}: ${await response.text()}`);
    const payload = await response.json();
    const raw = String(payload?.choices?.[0]?.message?.content ?? '');
    const match = raw.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(match?.[0] ?? raw);
    if (!REPO_BEHAVIORS.includes(obj.behavior)) throw new Error(`invalid behavior: ${obj.behavior}`);
    return obj.behavior;
  } finally { clearTimeout(timer); }
}

function workerPrompt({ task, brief, state, mode }) {
  const failure = state.lastValidation ? `\nLAST VALIDATION\n${clip(state.lastValidation.stderr || state.lastValidation.stdout, 6000)}` : '';
  const diff = git(state.cwd, ['diff', '--']);
  return `You are the cloud coding worker. Phase Repo Governor controls repository behavior; your job is coding only.\n\nTASK\n${task}\n\nMODE\n${mode}\n\nAUDITED REPOSITORY BRIEF\n${JSON.stringify(brief, null, 2)}\n${failure}\n\nCURRENT DIFF\n${clip(diff, 8000)}\n\nWork directly in the repository. Make the smallest correct implementation. Do not declare the whole task complete; the governor will validate/review it. End with a concise summary of files changed and assumptions.`;
}

export async function runRepoController({
  cwd = process.cwd(),
  task,
  dbPath = null,
  cloudCommand = process.env.PHASE_CLOUD_COMMAND,
  workerAdapter = null,
  policy = process.env.PHASE_CONTROLLER_POLICY ?? 'heuristic',
  controllerUrl = process.env.PHASE_CONTROLLER_URL ?? 'http://127.0.0.1:8080/v1',
  controllerModel = process.env.PHASE_CONTROLLER_MODEL ?? 'phase-repo-governor',
  maxSteps = Number(process.env.PHASE_CONTROLLER_MAX_STEPS ?? 12),
  maxRepairs = Number(process.env.PHASE_CONTROLLER_MAX_REPAIRS ?? 2),
  workerIsolation = null,
  workerEnv = {},
  onStep = null
} = {}) {
  if (!task) throw new Error('task is required');
  cwd = resolve(cwd);
  const store = new BrainStore(resolve(dbPath ?? join(cwd, '.phase', 'repo-brain.sqlite')));
  const phaseIndex = loadPhaseIndexForStore(store);
  const git0 = gitSnapshot(cwd);
  const sessionId = store.startSession({ cwd, sessionFile: `repo-controller:${randomUUID()}`, gitCommit: git0.commit });
  const safeTask = redactSecrets(task);
  store.addObservation({ sessionId, toolName: '__user_prompt__', input: { source: 'repo-controller' }, outputText: safeTask, outputSha256: sha256(safeTask), rawOutputSha256: sha256(task), cwd, gitCommit: git0.commit, gitDirty: git0.dirty, gitStatusHash: git0.statusHash });

  const state = { cwd, task: safeTask, inspected: false, workerRuns: 0, validationAttempted: false, validationPassed: false, repairs: 0, maxRepairs, reviewed: false, reviewPassed: false, consolidated: false, lastValidation: null, brief: null, done: false, success: false };
  const trace = [];
  let error = null;
  const started = performance.now();
  try {
    for (let step = 1; step <= maxSteps && !state.done; step++) {
      const publicState = {
        task: state.task,
        inspected: state.inspected,
        workerRuns: state.workerRuns,
        validationAttempted: state.validationAttempted,
        validationPassed: state.validationPassed,
        repairs: state.repairs,
        maxRepairs: state.maxRepairs,
        reviewed: state.reviewed,
        reviewPassed: state.reviewPassed,
        consolidated: state.consolidated,
        hasValidationCommand: Boolean(state.brief?.validation),
        hasWorkingTreeDiff: Boolean(git(cwd, ['diff', '--shortstat']))
      };
      const behavior = policy === 'model' ? await callBehaviorModel({ state: publicState, baseUrl: controllerUrl, model: controllerModel }) : heuristicBehavior(publicState);
      const toolCallId = `repo-${sessionId}-${String(step).padStart(3, '0')}`;
      store.addAction({ sessionId, toolCallId, toolName: `repo:${behavior}`, input: { state: publicState } });
      let resultText = '';
      let isError = false;
      try {
        if (behavior === 'inspect') {
          state.brief = inspectRepository(cwd, safeTask, store, phaseIndex);
          state.inspected = true;
          resultText = JSON.stringify(state.brief);
        } else if (behavior === 'delegate' || behavior === 'repair') {
          if (!state.brief) state.brief = inspectRepository(cwd, safeTask, store, phaseIndex);
          const worker = await runCloudWorker({ cwd, prompt: workerPrompt({ task: safeTask, brief: state.brief, state, mode: behavior }), adapter: workerAdapter, command: cloudCommand, extraEnv: { ...workerEnv, PHASE_DB: store.dbPath }, isolation: workerIsolation });
          state.workerRuns += 1;
          if (behavior === 'repair') { state.repairs += 1; state.validationAttempted = false; state.validationPassed = false; }
          resultText = JSON.stringify(worker);
          if (!worker.ok) isError = true;
        } else if (behavior === 'validate') {
          state.validationAttempted = true;
          if (!state.brief?.validation) {
            state.validationPassed = false;
            state.lastValidation = { status: 64, stdout: '', stderr: 'No validation command detected. Set PHASE_VALIDATE_COMMAND.' };
          } else {
            state.lastValidation = run(cwd, state.brief.validation);
            state.validationPassed = state.lastValidation.status === 0;
          }
          resultText = JSON.stringify(state.lastValidation);
        } else if (behavior === 'review') {
          const diffCheck = run(cwd, ['git', 'diff', '--check']);
          const diff = git(cwd, ['diff', '--']);
          state.reviewed = true;
          state.reviewPassed = diffCheck.status === 0 && diff.length > 0;
          resultText = JSON.stringify({ diffCheck, diff: clip(diff, 12000), reviewPassed: state.reviewPassed });
        } else if (behavior === 'consolidate') {
          if (!state.validationPassed) throw new Error('cannot consolidate an unvalidated task');
          const text = `Validated repository task: ${safeTask}\nvalidation=${state.brief?.validation?.join(' ') ?? 'unknown'}\nreviewPassed=${state.reviewPassed}`;
          const snap = gitSnapshot(cwd);
          const oid = store.addObservation({ sessionId, toolName: '__validated_task__', input: { validation: state.brief?.validation }, outputText: text, outputSha256: sha256(text), rawOutputSha256: sha256(text), cwd, gitCommit: snap.commit, gitDirty: snap.dirty, gitStatusHash: snap.statusHash });
          store.addClaim({ sessionId, claim: `Validated task completed in this repository: ${safeTask}`, evidenceIds: [oid], confidence: 1 });
          phaseIndex.rebuild(store.listActiveClaims(), store.activeClaimDigest());
          state.consolidated = true;
          resultText = `consolidated ${oid}`;
        } else if (behavior === 'finish') {
          state.done = true;
          state.success = Boolean(state.validationPassed && state.reviewPassed);
          resultText = state.success ? 'finished: validated and reviewed' : 'finished: acceptance gate not met';
        }
      } catch (e) { isError = true; resultText = `ERROR: ${String(e)}`; }
      store.completeAction(toolCallId, { resultText: redactSecrets(resultText), isError });
      trace.push({ step, behavior, state: publicState, result: redactSecrets(resultText), isError });
      if (onStep) await onStep(trace.at(-1));
    }
  } catch (e) { error = String(e); }
  finally {
    try { store.endSession(sessionId); } catch {}
    try { phaseIndex.claimDigest = store.activeClaimDigest(); phaseIndex.save(); } catch {}
    const ledgerHead = store.ledgerHead();
    const audit = store.audit([]);
    store.close();
    return { ok: state.success && !error && audit.passed, success: state.success, error, sessionId, dbPath: resolve(dbPath ?? join(cwd, '.phase', 'repo-brain.sqlite')), ledgerHead, trace, state, audit, wallTimeMs: performance.now() - started };
  }
}
