import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { BrainStore } from "./store.mjs";
import { loadPhaseIndexForStore } from "./phase-index.mjs";
import { retrieveClaims } from "./retrieval.mjs";
import { claimFreshness } from "./freshness.mjs";
import { STUDENT_TOOLS, executeStudentTool } from "./slm-tools.mjs";
import { gitSnapshot, redactSecrets, sha256 } from "./util.mjs";

const ACTION_SYSTEM = `You are Phase Student, a local coding-agent policy model.
Your job is to choose exactly ONE next action that advances the user's task.
You have an external audited memory (Phase), so do not try to memorize the repository.
Prefer targeted reads/searches over broad exploration. Run relevant tests before finishing.
Use phase_remember only for reusable facts backed by O... evidence receipts.
Never invent evidence IDs. Do not claim success without validation when validation is available.`;

const JSON_ACTION_RULE = `Return ONLY one compact JSON object with this exact shape:
{"tool":"<tool-name>","args":{...}}
No markdown, no reasoning, no prose outside the JSON.`;

function clip(text, max = 5000) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n...[truncated]`;
}

function memoryBlock(claims) {
  if (!claims.length) return "(none)";
  return claims.map((claim) => {
    const fresh = claimFreshness(claim);
    const evidence = claim.evidence.map((o) => o.public_id).join(", ");
    return `${claim.public_id} [${fresh.status}] ${claim.claim} (evidence: ${evidence})`;
  }).join("\n");
}

function historyBlock(history, maxItems = 8) {
  if (!history.length) return "(none yet)";
  return history.slice(-maxItems).map((h, i) => {
    const args = JSON.stringify(h.args ?? {});
    return `${i + 1}. ${h.tool} ${clip(args, 1000)}\n=> ${clip(h.result, 3000)}`;
  }).join("\n\n");
}

function toolCatalog() {
  return STUDENT_TOOLS.map((t) => `${t.function.name}: ${t.function.description}`).join("\n");
}

function parseJsonAction(content) {
  const raw = String(content ?? "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidates = [raw, fenced].filter(Boolean);
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const text of candidates) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj.tool === "string" && obj.args && typeof obj.args === "object") return obj;
    } catch {}
  }
  throw new Error(`model did not return a valid action JSON: ${clip(raw, 600)}`);
}

function parseToolCall(message) {
  const calls = message?.tool_calls;
  if (Array.isArray(calls) && calls.length) {
    const fn = calls[0]?.function ?? {};
    let args = fn.arguments ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    if (typeof fn.name === "string") return { tool: fn.name, args };
  }
  return parseJsonAction(message?.content ?? "");
}

async function postJson(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.PHASE_STUDENT_API_KEY ?? "no-key"}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`model server ${response.status}: ${await response.text()}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function callStudentModel({ baseUrl, model, protocol, stateText, temperature = 0, timeoutMs = 120000 }) {
  const base = String(baseUrl).replace(/\/$/, "");
  const messages = [
    { role: "system", content: protocol === "json-action" ? `${ACTION_SYSTEM}\n\n${JSON_ACTION_RULE}\n\nAvailable tools:\n${toolCatalog()}` : ACTION_SYSTEM },
    { role: "user", content: stateText }
  ];
  const request = {
    model,
    messages,
    temperature,
    max_tokens: Number(process.env.PHASE_STUDENT_MAX_TOKENS ?? 768),
    stream: false
  };
  if (protocol === "tool-call") {
    request.tools = STUDENT_TOOLS;
    request.tool_choice = "required";
  }
  const started = performance.now();
  const payload = await postJson(`${base}/chat/completions`, request, timeoutMs);
  const latencyMs = performance.now() - started;
  const message = payload?.choices?.[0]?.message;
  if (!message) throw new Error(`model server returned no assistant message: ${JSON.stringify(payload).slice(0, 1000)}`);
  return { action: protocol === "tool-call" ? parseToolCall(message) : parseJsonAction(message.content), raw: message, usage: payload.usage ?? null, latencyMs };
}

export async function runStudent({
  cwd = process.cwd(),
  task,
  dbPath = null,
  phaseIndexPath = null,
  baseUrl = process.env.PHASE_STUDENT_URL ?? "http://127.0.0.1:8080/v1",
  model = process.env.PHASE_STUDENT_MODEL ?? "phase-student",
  protocol = process.env.PHASE_STUDENT_PROTOCOL ?? "json-action",
  maxSteps = Number(process.env.PHASE_STUDENT_MAX_STEPS ?? 40),
  timeoutMs = Number(process.env.PHASE_STUDENT_TIMEOUT_MS ?? 120000),
  onStep = null
} = {}) {
  if (!task) throw new Error("task is required");
  cwd = resolve(cwd);
  const resolvedDb = resolve(dbPath ?? `${cwd}/.phase/student-brain.sqlite`);
  if (phaseIndexPath) process.env.PHASE_INDEX_PATH = resolve(phaseIndexPath);
  const store = new BrainStore(resolvedDb);
  const phaseIndex = loadPhaseIndexForStore(store);
  const git = gitSnapshot(cwd);
  const sessionId = store.startSession({ cwd, sessionFile: `student:${randomUUID()}`, gitCommit: git.commit });
  const safeTask = redactSecrets(String(task));
  const promptReceipt = store.addObservation({
    sessionId,
    toolName: "__user_prompt__",
    input: { source: "student-runtime" },
    outputText: safeTask,
    outputSha256: sha256(safeTask),
    rawOutputSha256: sha256(String(task)),
    cwd,
    gitCommit: git.commit,
    gitDirty: git.dirty,
    gitStatusHash: git.statusHash
  });

  const runStarted = performance.now();
  const history = [];
  const telemetry = { modelCalls: 0, promptTokens: 0, completionTokens: 0, parseErrors: 0, toolErrors: 0, modelLatencyMs: 0 };
  let finished = false;
  let summary = "";
  let error = null;

  try {
    for (let step = 1; step <= maxSteps; step++) {
      const recallQuery = `${safeTask}\n${history.slice(-2).map((h) => h.result).join("\n")}`;
      const retrieval = retrieveClaims(store, recallQuery, 5, phaseIndex, process.env.PHASE_RETRIEVAL ?? "hybrid", cwd);
      const recalledMemoryText = memoryBlock(retrieval.claims);
      store.addObservation({
        sessionId,
        toolName: "__phase_injection__",
        input: { source: "student-runtime", step, query: recallQuery, backend: retrieval.backend },
        outputText: recalledMemoryText,
        outputSha256: sha256(recalledMemoryText),
        rawOutputSha256: sha256(recalledMemoryText),
        cwd,
        gitCommit: git.commit,
        gitDirty: git.dirty,
        gitStatusHash: git.statusHash
      });
      const stateText = `TASK\n${safeTask}\n\nCURRENT PROMPT RECEIPT\n${promptReceipt}\n\nAUDITED PHASE MEMORIES\n${recalledMemoryText}\n\nRECENT ACTIONS\n${historyBlock(history)}\n\nChoose the single best next action.`;
      let generated;
      try {
        generated = await callStudentModel({ baseUrl, model, protocol, stateText, timeoutMs });
        telemetry.modelCalls += 1;
        telemetry.promptTokens += Number(generated.usage?.prompt_tokens ?? 0);
        telemetry.completionTokens += Number(generated.usage?.completion_tokens ?? 0);
        telemetry.modelLatencyMs += Number(generated.latencyMs ?? 0);
      } catch (e) {
        telemetry.parseErrors += 1;
        history.push({ tool: "model_error", args: {}, result: `MODEL ERROR: ${String(e)}` });
        if (telemetry.parseErrors >= 3) throw e;
        continue;
      }

      const action = generated.action;
      const toolCallId = `student-${sessionId}-${String(step).padStart(3, "0")}`;
      const result = await executeStudentTool({ tool: action.tool, args: action.args, cwd, store, phaseIndex, sessionId, toolCallId });
      if (result.isError) telemetry.toolErrors += 1;
      history.push({ tool: action.tool, args: action.args, result: result.text, actionId: result.actionId, observationId: result.observationId });
      if (onStep) await onStep({ step, action, result, retrieval, telemetry: { ...telemetry } });
      if (result.finished) {
        finished = true;
        summary = result.summary ?? "";
        break;
      }
    }
  } catch (e) {
    error = String(e);
  } finally {
    try { store.endSession(sessionId); } catch {}
    try { phaseIndex.claimDigest = store.activeClaimDigest(); phaseIndex.save(); } catch {}
    const ledgerHead = store.ledgerHead();
    const status = store.status();
    store.close();
    return {
      ok: finished && !error,
      finished,
      summary,
      error,
      sessionId,
      dbPath: resolvedDb,
      ledgerHead,
      steps: history.length,
      history,
      telemetry: { ...telemetry, wallTimeMs: performance.now() - runStarted },
      status
    };
  }
}
