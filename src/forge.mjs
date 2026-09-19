import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BrainStore } from "./store.mjs";
import { STUDENT_TOOLS } from "./slm-tools.mjs";
import { sha256, stableJson } from "./util.mjs";

const DEVELOPER = "You are Phase Student, a local coding-agent policy model. Choose exactly one next tool action. Prefer targeted exploration, use evidence-backed Phase memory, validate before finishing, and never invent evidence receipts.";

function clip(text, max = 5000) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n...[truncated]`;
}

function jsonl(rows) {
  return rows.map((x) => JSON.stringify(x)).join("\n") + (rows.length ? "\n" : "");
}

function taskPrompt(store, sessionId) {
  const obs = store.listSessionObservations(sessionId).find((o) => o.tool_name === "__user_prompt__");
  return obs?.output_text ?? "";
}

function phaseInjection(store, sessionId, step = null) {
  const rows = store.listSessionObservations(sessionId).filter((o) => o.tool_name === "__phase_injection__");
  if (step !== null) {
    const exact = rows.find((o) => Number(o.input?.step) === Number(step));
    if (exact) return exact.output_text;
  }
  return rows.at(-1)?.output_text ?? "(none)";
}

function stateText(task, history, phaseMemories = "(none)") {
  const h = history.length ? history.slice(-8).map((x, i) => `${i + 1}. ${x.tool} ${clip(JSON.stringify(x.args), 1000)}\n=> ${clip(x.result, 3000)}`).join("\n\n") : "(none yet)";
  return `TASK\n${task}\n\nAUDITED PHASE MEMORIES SEEN BY TEACHER\n${phaseMemories}\n\nRECENT ACTIONS\n${h}\n\nChoose the single best next action.`;
}

function genericExample({ taskId, sessionId, step, task, phaseMemories, history, target, accepted, ledgerHead }) {
  return {
    schema: "phase-action-v1",
    id: `${taskId}:${String(step).padStart(3, "0")}`,
    accepted,
    source: { taskId, sessionId, ledgerHead },
    state: { task, phaseMemories, recentActions: history.slice(-8) },
    target
  };
}

function functionGemmaExample({ taskId, sessionId, step, task, phaseMemories, history, target, accepted, ledgerHead }) {
  return {
    id: `${taskId}:${String(step).padStart(3, "0")}`,
    accepted,
    source: { taskId, sessionId, ledgerHead },
    messages: [
      { role: "developer", content: DEVELOPER },
      { role: "user", content: stateText(task, history, phaseMemories) },
      { role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: target.tool, arguments: target.args } }] }
    ],
    tools: STUDENT_TOOLS
  };
}

function jsonActionExample({ taskId, sessionId, step, task, phaseMemories, history, target, accepted, ledgerHead }) {
  return {
    id: `${taskId}:${String(step).padStart(3, "0")}`,
    accepted,
    source: { taskId, sessionId, ledgerHead },
    messages: [
      { role: "system", content: `${DEVELOPER}\nReturn ONLY JSON: {\"tool\":\"<tool>\",\"args\":{...}}` },
      { role: "user", content: stateText(task, history, phaseMemories) },
      { role: "assistant", content: JSON.stringify(target) }
    ]
  };
}

function examplesForSession(store, { taskId, sessionId, accepted, ledgerHead }) {
  const task = taskPrompt(store, sessionId);
  if (!task) return { generic: [], functiongemma: [], jsonAction: [] };
  const actions = store.listSessionActions(sessionId);
  const generic = [];
  const functiongemma = [];
  const jsonAction = [];
  const history = [];
  let step = 0;
  for (const action of actions) {
    if (action.tool_name.startsWith("phase_status") || action.tool_name.startsWith("phase_audit")) continue;
    step += 1;
    const target = { tool: action.tool_name, args: action.input ?? {} };
    const phaseMemories = phaseInjection(store, sessionId, step);
    const data = { taskId, sessionId, step, task, phaseMemories, history, target, accepted, ledgerHead };
    generic.push(genericExample(data));
    functiongemma.push(functionGemmaExample(data));
    jsonAction.push(jsonActionExample(data));
    history.push({ tool: action.tool_name, args: action.input ?? {}, result: action.result_text ?? "" });
  }
  if (accepted && !actions.some((a) => a.tool_name === "finish")) {
    step += 1;
    const target = { tool: "finish", args: { summary: "Task complete; validator passed." } };
    const phaseMemories = phaseInjection(store, sessionId, step);
    const data = { taskId, sessionId, step, task, phaseMemories, history, target, accepted, ledgerHead };
    generic.push(genericExample(data));
    functiongemma.push(functionGemmaExample(data));
    jsonAction.push(jsonActionExample(data));
  }
  return { generic, functiongemma, jsonAction };
}

export function compileSuiteDataset({ suiteResultPath, outDir }) {
  const suitePath = resolve(suiteResultPath);
  const suite = JSON.parse(readFileSync(suitePath, "utf8"));
  const brainDb = resolve(suite.brainDb);
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  const store = new BrainStore(brainDb);
  const accepted = { generic: [], functiongemma: [], jsonAction: [] };
  const rejected = { generic: [], functiongemma: [], jsonAction: [] };
  const sources = [];
  try {
    for (const row of suite.results ?? []) {
      const result = row.result ?? {};
      const sessionId = result.sessionId;
      if (!sessionId) continue;
      const ok = Boolean(result.passed);
      const ledgerHead = result.ledgerHeadBeforeHidden ?? result.audit?.ledgerHead ?? null;
      const built = examplesForSession(store, { taskId: row.task, sessionId, accepted: ok, ledgerHead });
      const dest = ok ? accepted : rejected;
      for (const key of Object.keys(dest)) dest[key].push(...built[key]);
      sources.push({ taskId: row.task, sessionId, passed: ok, ledgerHead, actions: built.generic.length });
    }
  } finally {
    store.close();
  }

  const files = {
    accepted: resolve(out, "accepted.phase-action.jsonl"),
    rejected: resolve(out, "rejected.phase-action.jsonl"),
    functiongemma: resolve(out, "accepted.functiongemma.jsonl"),
    jsonAction: resolve(out, "accepted.json-action.jsonl")
  };
  writeFileSync(files.accepted, jsonl(accepted.generic));
  writeFileSync(files.rejected, jsonl(rejected.generic));
  writeFileSync(files.functiongemma, jsonl(accepted.functiongemma));
  writeFileSync(files.jsonAction, jsonl(accepted.jsonAction));

  const hashes = Object.fromEntries(Object.entries(files).map(([k, path]) => [k, sha256(readFileSync(path))]));
  const manifest = {
    schema: "phase-forge-v1",
    suiteId: suite.suiteId,
    suiteResultPath: suitePath,
    suiteResultSha256: sha256(readFileSync(suitePath)),
    brainDb,
    acceptedTasks: sources.filter((s) => s.passed).length,
    rejectedTasks: sources.filter((s) => !s.passed).length,
    acceptedActions: accepted.generic.length,
    rejectedActions: rejected.generic.length,
    sources,
    files,
    hashes,
    manifestDigest: sha256(stableJson({ sources, hashes }))
  };
  writeFileSync(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
