import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BrainStore } from './store.mjs';
import { REPO_BEHAVIORS } from './repo-controller.mjs';
import { sha256 } from './util.mjs';

function jsonl(rows) { return rows.map(x => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : ''); }
function taskPrompt(store, sessionId) { return store.listSessionObservations(sessionId).find(o => o.tool_name === '__user_prompt__')?.output_text ?? ''; }

function commandText(a) {
  const x = a.input ?? {};
  return String(x.command ?? x.cmd ?? x.script ?? x.args ?? '');
}
function isValidation(a) {
  if (!['bash','powershell','shell','exec'].includes(a.tool_name)) return false;
  return /(?:^|\s)(?:pytest|test|tests|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|vitest|jest|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|lint|typecheck|check)(?:\s|$)/i.test(commandText(a));
}
function isMutation(a) { return ['edit','write','apply_patch','patch'].includes(a.tool_name); }
function isReview(a) {
  if (['read','grep','find','ls'].includes(a.tool_name)) return true;
  return ['bash','powershell','shell','exec'].includes(a.tool_name) && /git\s+(?:diff|status)|(?:^|\s)(?:rg|grep|find|ls)(?:\s|$)/i.test(commandText(a));
}
function lowLevelBehavior(a, state) {
  if (a.tool_name === 'phase_remember') return 'consolidate';
  if (a.tool_name === 'finish') return 'finish';
  if (isValidation(a)) return 'validate';
  if (isMutation(a)) return state.validationAttempted && !state.validationPassed ? 'repair' : 'delegate';
  if (isReview(a)) return state.validationPassed ? 'review' : 'inspect';
  if (a.tool_name.startsWith('phase_')) return 'inspect';
  return null;
}
function snapshotState(task, s) {
  return {
    task,
    inspected: s.inspected,
    workerRuns: s.workerRuns,
    validationAttempted: s.validationAttempted,
    validationPassed: s.validationPassed,
    repairs: s.repairs,
    reviewed: s.reviewed,
    reviewPassed: s.reviewed && s.validationPassed,
    consolidated: s.consolidated,
    toolErrors: s.toolErrors,
    mutationCount: s.mutationCount
  };
}
function advance(s, behavior, action) {
  if (behavior === 'inspect') s.inspected = true;
  if (behavior === 'delegate') { s.workerRuns += 1; s.mutationCount += isMutation(action) ? 1 : 0; }
  if (behavior === 'validate') { s.validationAttempted = true; s.validationPassed = !Boolean(action.is_error); }
  if (behavior === 'repair') { s.workerRuns += 1; s.repairs += 1; s.mutationCount += 1; s.validationAttempted = false; s.validationPassed = false; }
  if (behavior === 'review') s.reviewed = true;
  if (behavior === 'consolidate') s.consolidated = true;
}

export function inferBehaviorTrace({ task, actions, accepted }) {
  const s = { inspected: false, workerRuns: 0, validationAttempted: false, validationPassed: false, repairs: 0, reviewed: false, consolidated: false, toolErrors: 0, mutationCount: 0 };
  const out = [];
  let lastBehavior = null;
  for (const action of actions) {
    if (action.is_error) s.toolErrors += 1;
    const behavior = lowLevelBehavior(action, s);
    if (!behavior) continue;
    // Collapse runs of low-level reads/searches/edits into one high-level decision.
    if (behavior !== lastBehavior) out.push({ state: snapshotState(task, s), target: { behavior }, sourceTool: action.tool_name });
    advance(s, behavior, action);
    lastBehavior = behavior;
  }
  if (accepted) {
    if (!s.reviewed && s.validationPassed) {
      out.push({ state: snapshotState(task, s), target: { behavior: 'review' }, sourceTool: '__synthetic_review__' });
      s.reviewed = true;
    }
    if (!s.consolidated && s.validationPassed) {
      out.push({ state: snapshotState(task, s), target: { behavior: 'consolidate' }, sourceTool: '__synthetic_consolidate__' });
      s.consolidated = true;
    }
    if (out.at(-1)?.target?.behavior !== 'finish') out.push({ state: snapshotState(task, s), target: { behavior: 'finish' }, sourceTool: '__synthetic_finish__' });
  }
  return out;
}

function directControllerTrace(task, actions) {
  return actions.filter(a => a.tool_name.startsWith('repo:')).map(a => ({
    state: { task, ...(a.input?.state ?? {}) },
    target: { behavior: a.tool_name.slice(5) },
    sourceTool: a.tool_name
  })).filter(x => REPO_BEHAVIORS.includes(x.target.behavior));
}

export function compileBehaviorDataset({ suiteResultPath, outDir }) {
  const suitePath = resolve(suiteResultPath);
  const suite = JSON.parse(readFileSync(suitePath, 'utf8'));
  const db = resolve(suite.brainDb);
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  const store = new BrainStore(db);
  const accepted = [], rejected = [], sources = [];
  try {
    for (const row of suite.results ?? []) {
      const result = row.result ?? {};
      if (!result.sessionId) continue;
      const pass = Boolean(result.passed ?? result.success ?? result.ok);
      const task = taskPrompt(store, result.sessionId) || String(row.prompt ?? row.task ?? '');
      const actions = store.listSessionActions(result.sessionId);
      const direct = actions.some(a => a.tool_name.startsWith('repo:'));
      const inferred = direct ? directControllerTrace(task, actions) : inferBehaviorTrace({ task, actions, accepted: pass });
      const rows = inferred.map((x, i) => ({
        schema: 'phase-repo-behavior-v1',
        id: `${row.task ?? result.sessionId}:${String(i + 1).padStart(3, '0')}`,
        accepted: pass,
        source: { taskId: row.task ?? null, sessionId: result.sessionId, ledgerHead: result.ledgerHeadBeforeHidden ?? result.ledgerHead ?? null, sourceTool: x.sourceTool, traceType: direct ? 'controller' : 'cloud-agent-inferred' },
        state: x.state,
        target: x.target
      }));
      (pass ? accepted : rejected).push(...rows);
      sources.push({ taskId: row.task ?? null, sessionId: result.sessionId, passed: pass, traceType: direct ? 'controller' : 'cloud-agent-inferred', behaviors: rows.length });
    }
  } finally { store.close(); }
  const acceptedPath = resolve(out, 'accepted.repo-behavior.jsonl');
  const rejectedPath = resolve(out, 'rejected.repo-behavior.jsonl');
  const chatPath = resolve(out, 'accepted.repo-behavior-chat.jsonl');
  writeFileSync(acceptedPath, jsonl(accepted));
  writeFileSync(rejectedPath, jsonl(rejected));
  const system = `You are Phase Repo Governor. You manage repository behavior but never write code. Choose exactly one behavior: ${REPO_BEHAVIORS.join(', ')}. Return only JSON {\"behavior\":\"...\"}.`;
  const chatRows = accepted.map(x => ({ id: x.id, source: x.source, messages: [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(x.state) },
    { role: 'assistant', content: JSON.stringify(x.target) }
  ] }));
  writeFileSync(chatPath, jsonl(chatRows));
  const manifest = { schema: 'phase-behavior-forge-v1', suiteResultPath: suitePath, brainDb: db, acceptedExamples: accepted.length, rejectedExamples: rejected.length, sources, files: { accepted: acceptedPath, rejected: rejectedPath, chat: chatPath }, hashes: { accepted: sha256(readFileSync(acceptedPath)), rejected: sha256(readFileSync(rejectedPath)), chat: sha256(readFileSync(chatPath)) } };
  writeFileSync(resolve(out, 'behavior-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
