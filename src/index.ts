import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve, join } from "node:path";
import { BrainStore } from "./store.mjs";
import { loadPhaseIndexForStore } from "./phase-index.mjs";
import { claimFreshness } from "./freshness.mjs";
import { retrieveClaims as retrievePhaseClaims } from "./retrieval.mjs";
import { artifactSnapshot, gitSnapshot, redactSecrets, sha256, stringifyContent, tokenize } from "./util.mjs";
import { runRepoController } from "./repo-controller.mjs";

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function trimBytes(text: string, maxBytes: number) {
  const b = Buffer.from(text, "utf8");
  if (b.length <= maxBytes) return { text, truncated: false };
  return { text: b.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export default function phaseMemory(pi: ExtensionAPI) {
  let store: BrainStore | null = null;
  let phaseIndex: any = null;
  let sessionId: string | null = null;
  let cwd = process.cwd();

  const getStore = () => {
    if (!store) {
      const dbPath = process.env.PHASE_DB ? resolve(process.env.PHASE_DB) : join(cwd, ".phase", "brain.sqlite");
      store = new BrainStore(dbPath);
    }
    return store;
  };

  const getPhaseIndex = () => {
    if (!phaseIndex) phaseIndex = loadPhaseIndexForStore(getStore());
    return phaseIndex;
  };

  const retrieveClaims = (query: string, limit = 6) =>
    retrievePhaseClaims(getStore(), query, limit, getPhaseIndex(), String(process.env.PHASE_RETRIEVAL ?? "hybrid"), cwd);

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    const git = gitSnapshot(cwd);
    const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    sessionId = getStore().startSession({ cwd, sessionFile, gitCommit: git.commit });
    if (ctx.hasUI) ctx.ui.setStatus("phase", "Phase: recording");
  });

  pi.on("session_shutdown", async () => {
    if (store && sessionId) {
      try { store.endSession(sessionId); } catch {}
    }
    if (phaseIndex) {
      try { phaseIndex.claimDigest = getStore().activeClaimDigest(); phaseIndex.save(); } catch {}
    }
    if (store) {
      try { store.close(); } catch {}
    }
    store = null;
    phaseIndex = null;
    sessionId = null;
  });

  pi.on("tool_call", async (event) => {
    if (!sessionId) return;
    try {
      getStore().addAction({
        sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: JSON.parse(redactSecrets(JSON.stringify(event.input ?? {})))
      });
    } catch {}
  });

  pi.on("tool_result", async (event) => {
    if (!sessionId) return;
    const actionResultText = redactSecrets(stringifyContent(event.content));
    try { getStore().completeAction(event.toolCallId, { resultText: actionResultText, isError: Boolean(event.isError) }); } catch {}
    if (event.toolName.startsWith("phase_")) return;
    const rawOutput = stringifyContent(event.content);
    const redacted = redactSecrets(rawOutput);
    const maxBytes = Math.max(4096, Number(process.env.PHASE_MAX_OBSERVATION_BYTES ?? 1048576));
    const clipped = trimBytes(redacted, maxBytes);
    const git = gitSnapshot(cwd);
    const artifact = artifactSnapshot(cwd, event.input as any);
    const observationId = getStore().addObservation({
      sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: JSON.parse(redactSecrets(JSON.stringify(event.input ?? {}))),
      outputText: clipped.text,
      outputSha256: sha256(clipped.text),
      rawOutputSha256: sha256(rawOutput),
      outputTruncated: clipped.truncated,
      cwd,
      gitCommit: git.commit,
      gitDirty: git.dirty,
      gitStatusHash: git.statusHash,
      artifactPath: artifact.path,
      artifactSha256: artifact.hash
    });
    return {
      content: [...event.content, { type: "text" as const, text: `\n[phase evidence: ${observationId}]` }]
    };
  });

  pi.on("before_agent_start", async (event) => {
    if (!sessionId) return;
    const git = gitSnapshot(cwd);
    const promptText = redactSecrets(event.prompt);
    const promptObservationId = getStore().addObservation({
      sessionId,
      toolName: "__user_prompt__",
      input: { source: "user" },
      outputText: promptText,
      outputSha256: sha256(promptText),
      rawOutputSha256: sha256(event.prompt),
      cwd,
      gitCommit: git.commit,
      gitDirty: git.dirty,
      gitStatusHash: git.statusHash
    });

    const systemText = redactSecrets(event.systemPrompt);
    getStore().addObservation({
      sessionId,
      toolName: "__system_prompt__",
      input: { source: "pi", stage: "before_phase_injection" },
      outputText: systemText,
      outputSha256: sha256(systemText),
      rawOutputSha256: sha256(event.systemPrompt),
      cwd,
      gitCommit: git.commit,
      gitDirty: git.dirty,
      gitStatusHash: git.statusHash
    });

    const sections = [
      `Current user prompt receipt: ${promptObservationId}. You may cite this receipt for facts explicitly supplied by the user.`
    ];
    if (process.env.PHASE_AUTO_RECALL !== "0") {
      const retrieval = retrieveClaims(event.prompt, 5);
      const recalled = retrieval.claims;
      if (recalled.length) {
        sections.push(`Persistent Phase memories relevant to this request follow (retrieval: ${retrieval.backend}). Treat stale/untracked memories as hints, not truth. Every memory can be inspected by ID.`);
        const memoryLines: string[] = [];
        for (const claim of recalled) {
          const fresh = claimFreshness(claim);
          const evidence = claim.evidence.map((o: any) => o.public_id).join(", ");
          const line = `- ${claim.public_id} [${fresh.status}] ${claim.claim} (evidence: ${evidence})`;
          sections.push(line);
          memoryLines.push(line);
        }
        const memoryText = memoryLines.join("\n");
        getStore().addObservation({
          sessionId,
          toolName: "__phase_injection__",
          input: { query: promptText, backend: retrieval.backend },
          outputText: memoryText,
          outputSha256: sha256(memoryText),
          rawOutputSha256: sha256(memoryText),
          cwd,
          gitCommit: git.commit,
          gitDirty: git.dirty,
          gitStatusHash: git.statusHash
        });
      }
    }
    event.systemPromptOptions.sections["phase-memory"] = sections.join("\n");
    event.systemPromptOptions.promptGuidelines.push("When you establish reusable repository knowledge, call phase_remember with one or more Phase observation IDs shown in tool results or the current prompt receipt. Never invent evidence IDs.");
  });


  pi.registerCommand("phase-run", {
    description: "Run a task through the Phase repository governor; cloud model remains the coding worker",
    handler: async (args, ctx) => {
      const task = String(args ?? "").trim();
      if (!task) { ctx.ui.notify("Usage: /phase-run <task>", "warning"); return; }
      ctx.ui.notify("Phase Repo Governor started.", "info");
      const result = await runRepoController({ cwd: ctx.cwd, task });
      const trace = result.trace.map((x: any) => x.behavior).join(" → ");
      ctx.ui.notify(`${result.ok ? "PASS" : "FAIL"}: ${trace}${result.error ? `\n${result.error}` : ""}`, result.ok ? "info" : "error");
    },
  });

  pi.registerTool({
    name: "phase_remember",
    label: "Phase Remember",
    description: "Persist a reusable claim. Every claim MUST cite one or more immutable Phase observation IDs (O...). Ungrounded writes are rejected.",
    parameters: Type.Object({
      claim: Type.String({ minLength: 1 }),
      evidence_ids: Type.Array(Type.String({ minLength: 2 }), { minItems: 1 }),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 }))
    }),
    async execute(_id, params) {
      if (!sessionId) return textResult("Phase session is not initialized.", { ok: false });
      try {
        const safeClaim = redactSecrets(params.claim);
        const memoryId = getStore().addClaim({ sessionId, claim: safeClaim, evidenceIds: params.evidence_ids, confidence: params.confidence ?? 1 });
        let indexCues = 0;
        try {
          const idx = getPhaseIndex();
          indexCues = idx.addClaim(memoryId, safeClaim);
          idx.claimDigest = getStore().activeClaimDigest();
          idx.calibrateNoise(8);
          idx.save();
        } catch {}
        return textResult(`Stored ${memoryId}. Receipts: ${params.evidence_ids.join(", ")}. Phase-indexed under ${indexCues} cue(s).`, { ok: true, memoryId, indexCues });
      } catch (error) {
        return textResult(`REJECTED: ${String(error)}`, { ok: false });
      }
    }
  });

  pi.registerTool({
    name: "phase_recall",
    label: "Phase Recall",
    description: "Search the persistent second brain. Results include provenance IDs and freshness state.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 }))
    }),
    async execute(_id, params) {
      const retrieval = retrieveClaims(params.query, params.limit ?? 6);
      const rows = retrieval.claims;
      if (!rows.length) return textResult("No matching Phase memories.", { count: 0, backend: retrieval.backend, phase: retrieval.phase });
      const out = rows.map((claim) => {
        const fresh = claimFreshness(claim);
        const evidence = claim.evidence.map((o: any) => `${o.public_id}${o.artifact_path ? `:${o.artifact_path}` : ""}`).join(", ");
        return `${claim.public_id} [${fresh.status}] confidence=${Number(claim.confidence).toFixed(2)}\n${claim.claim}\nreceipts: ${evidence}`;
      }).join("\n\n");
      return textResult(out, { count: rows.length, backend: retrieval.backend, phase: retrieval.phase });
    }
  });

  pi.registerTool({
    name: "phase_inspect",
    label: "Phase Inspect",
    description: "Inspect a memory M... or observation O... and show its provenance.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      if (params.id.startsWith("O")) {
        const obs = getStore().getObservation(params.id);
        if (!obs) return textResult(`Not found: ${params.id}`, { ok: false });
        return textResult(JSON.stringify(obs, null, 2), { ok: true, kind: "observation" });
      }
      if (params.id.startsWith("M")) {
        const claim = getStore().getClaim(params.id);
        if (!claim) return textResult(`Not found: ${params.id}`, { ok: false });
        return textResult(JSON.stringify({ ...claim, freshness: claimFreshness(claim) }, null, 2), { ok: true, kind: "claim" });
      }
      return textResult("ID must begin with O (observation) or M (memory).", { ok: false });
    }
  });

  pi.registerTool({
    name: "phase_retract",
    label: "Phase Retract",
    description: "Retract a memory without deleting its audit history.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      try {
        getStore().retractClaim(params.id);
        try { getPhaseIndex().rebuild(getStore().listActiveClaims(), getStore().activeClaimDigest()); } catch {}
        return textResult(`Retracted ${params.id}. History remains auditable; phase index rebuilt from active claims.`, { ok: true });
      } catch (error) {
        return textResult(String(error), { ok: false });
      }
    }
  });

  pi.registerTool({
    name: "phase_status",
    label: "Phase Status",
    description: "Show second-brain counts and tamper-evident ledger head.",
    parameters: Type.Object({}),
    async execute() {
      const base = getStore().status();
      let index = null;
      try { index = { ...getPhaseIndex().stats(), audit: getPhaseIndex().audit(getStore()) }; } catch (error) { index = { error: String(error) }; }
      const status = { ...base, retrievalMode: String(process.env.PHASE_RETRIEVAL ?? "hybrid"), phaseIndex: index };
      return textResult(JSON.stringify(status, null, 2), status);
    }
  });

  pi.registerTool({
    name: "phase_audit",
    label: "Phase Audit",
    description: "Verify the tamper-evident provenance ledger and scan all retained observations for forbidden/hidden-test markers.",
    parameters: Type.Object({
      deny_patterns: Type.Optional(Type.Array(Type.String()))
    }),
    async execute(_id, params) {
      const provenance = getStore().audit(params.deny_patterns ?? []);
      let index;
      try { index = getPhaseIndex().audit(getStore()); } catch (error) { index = { passed: false, error: String(error) }; }
      const result = { ...provenance, index, passed: provenance.passed && index.passed };
      return textResult(JSON.stringify(result, null, 2), result);
    }
  });

  pi.registerCommand("phase-status", {
    description: "Show Phase second-brain status",
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(getStore().status()), "info")
  });

  pi.registerCommand("phase-audit", {
    description: "Verify Phase provenance ledger",
    handler: async (_args, ctx) => {
      const provenance = getStore().audit([]);
      let index;
      try { index = getPhaseIndex().audit(getStore()); } catch (error) { index = { passed: false, error: String(error) }; }
      const passed = provenance.passed && index.passed;
      ctx.ui.notify(passed ? `Phase audit PASS (${provenance.ledger.entries} ledger entries; phase index synced)` : "Phase audit FAIL", passed ? "info" : "error");
    }
  });

  pi.registerCommand("phase-rebuild", {
    description: "Rebuild the phase-native retrieval vector from active audited memories",
    handler: async (_args, ctx) => {
      const idx = getPhaseIndex();
      idx.rebuild(getStore().listActiveClaims(), getStore().activeClaimDigest());
      ctx.ui.notify(`Phase index rebuilt: ${idx.stats().cues} cues, ${idx.stats().fixedVectorBytes} fixed vector bytes`, "info");
    }
  });
}
