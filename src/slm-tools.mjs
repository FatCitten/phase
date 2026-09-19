import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { retrieveClaims } from "./retrieval.mjs";
import { claimFreshness } from "./freshness.mjs";
import { artifactSnapshot, gitSnapshot, redactSecrets, sha256 } from "./util.mjs";

export const STUDENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a UTF-8 text file in the workspace. Returns numbered lines.",
      parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 2000 } }, required: ["path"] }
    }
  },
  {
    type: "function",
    function: {
      name: "list",
      description: "List files and directories in the workspace.",
      parameters: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer", minimum: 0, maximum: 4 } } }
    }
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "Search workspace text files for a literal or regular-expression pattern.",
      parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string" }, regex: { type: "boolean" }, max_results: { type: "integer", minimum: 1, maximum: 200 } }, required: ["query"] }
    }
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Replace one exact text occurrence in a workspace file.",
      parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] }
    }
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Create or fully replace a UTF-8 workspace file.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }
    }
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the workspace, typically for tests, git status, or build commands.",
      parameters: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "integer", minimum: 100, maximum: 120000 } }, required: ["command"] }
    }
  },
  {
    type: "function",
    function: {
      name: "phase_recall",
      description: "Recall audited persistent repository memories relevant to a query.",
      parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 12 } }, required: ["query"] }
    }
  },
  {
    type: "function",
    function: {
      name: "phase_inspect",
      description: "Inspect an audited M... memory or O... observation in detail.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
    }
  },
  {
    type: "function",
    function: {
      name: "phase_retract",
      description: "Retract an incorrect or obsolete M... memory while preserving its audit history.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
    }
  },
  {
    type: "function",
    function: {
      name: "phase_remember",
      description: "Persist reusable knowledge. Must cite one or more O... evidence receipts from earlier tool results.",
      parameters: { type: "object", properties: { claim: { type: "string" }, evidence_ids: { type: "array", items: { type: "string" }, minItems: 1 }, confidence: { type: "number", minimum: 0, maximum: 1 } }, required: ["claim", "evidence_ids"] }
    }
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Stop when the requested task is complete and any useful validation has been run.",
      parameters: { type: "object", properties: { summary: { type: "string" } } }
    }
  }
];

function inside(root, requested = ".") {
  const abs = resolve(root, requested);
  const rel = relative(resolve(root), abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
  throw new Error(`path escapes workspace: ${requested}`);
}

function clip(text, max = 24000) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]`;
}

function numbered(text, offset = 1, limit = 400) {
  const lines = String(text).split(/\r?\n/);
  const start = Math.max(0, Number(offset || 1) - 1);
  const end = Math.min(lines.length, start + Math.max(1, Number(limit || 400)));
  return lines.slice(start, end).map((line, i) => `${start + i + 1}: ${line}`).join("\n");
}

function walk(root, start, depth, out, prefix = "") {
  if (depth < 0 || out.length >= 500) return;
  const entries = readdirSync(start, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if ([".git", ".phase", "node_modules", ".venv", "venv", "__pycache__"].includes(entry.name)) continue;
    const abs = resolve(start, entry.name);
    const rel = relative(root, abs).replaceAll("\\", "/");
    out.push(`${entry.isDirectory() ? "d" : "f"} ${rel}`);
    if (entry.isDirectory() && depth > 0) walk(root, abs, depth - 1, out, `${prefix}  `);
    if (out.length >= 500) break;
  }
}

function searchFiles(root, start, pattern, useRegex, maxResults) {
  const out = [];
  const rx = useRegex ? new RegExp(pattern, "i") : null;
  const stack = [start];
  while (stack.length && out.length < maxResults) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if ([".git", ".phase", "node_modules", ".venv", "venv", "__pycache__"].includes(entry.name)) continue;
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) { stack.push(abs); continue; }
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.size > 2_000_000) continue;
      let text;
      try { text = readFileSync(abs, "utf8"); } catch { continue; }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && out.length < maxResults; i++) {
        const hit = useRegex ? rx.test(lines[i]) : lines[i].toLowerCase().includes(pattern.toLowerCase());
        if (hit) out.push(`${relative(root, abs).replaceAll("\\", "/")}:${i + 1}:${lines[i].slice(0, 400)}`);
      }
    }
  }
  return out;
}

function memoryText(claims) {
  return claims.map((claim) => {
    const fresh = claimFreshness(claim);
    const evidence = claim.evidence.map((o) => o.public_id).join(", ");
    return `${claim.public_id} [${fresh.status}] ${claim.claim} (evidence: ${evidence})`;
  }).join("\n");
}

export async function executeStudentTool({ tool, args = {}, cwd, store, phaseIndex, sessionId, toolCallId }) {
  const safeArgs = JSON.parse(redactSecrets(JSON.stringify(args ?? {})));
  const actionId = store.addAction({ sessionId, toolCallId, toolName: tool, input: safeArgs });
  let text = "";
  let isError = false;
  let observationId = null;
  let finished = false;
  let summary = null;
  try {
    if (tool === "read") {
      const path = inside(cwd, args.path);
      text = numbered(readFileSync(path, "utf8"), args.offset ?? 1, args.limit ?? 400);
    } else if (tool === "list") {
      const path = inside(cwd, args.path ?? ".");
      const out = [];
      walk(resolve(cwd), path, args.depth ?? 2, out);
      text = out.join("\n");
    } else if (tool === "search") {
      const path = inside(cwd, args.path ?? ".");
      text = searchFiles(resolve(cwd), path, String(args.query ?? ""), Boolean(args.regex), Math.max(1, Math.min(200, Number(args.max_results ?? 50)))).join("\n");
    } else if (tool === "edit") {
      const path = inside(cwd, args.path);
      const before = readFileSync(path, "utf8");
      const count = before.split(String(args.old_text)).length - 1;
      if (count !== 1) throw new Error(`edit requires exactly one match, found ${count}`);
      writeFileSync(path, before.replace(String(args.old_text), String(args.new_text)));
      text = `edited ${relative(cwd, path)}`;
    } else if (tool === "write") {
      const path = inside(cwd, args.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(args.content ?? ""));
      text = `wrote ${relative(cwd, path)} (${Buffer.byteLength(String(args.content ?? ""))} bytes)`;
    } else if (tool === "bash") {
      if (process.env.PHASE_STUDENT_ALLOW_BASH === "0") throw new Error("bash disabled by PHASE_STUDENT_ALLOW_BASH=0");
      const r = spawnSync("bash", ["-lc", String(args.command ?? "")], {
        cwd, encoding: "utf8", timeout: Math.max(100, Math.min(120000, Number(args.timeout_ms ?? 30000))),
        stdio: ["ignore", "pipe", "pipe"]
      });
      text = `${r.stdout ?? ""}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}\n[exit ${r.status ?? 1}]`;
      if ((r.status ?? 1) !== 0) isError = true;
    } else if (tool === "phase_recall") {
      const r = retrieveClaims(store, String(args.query ?? ""), Number(args.limit ?? 6), phaseIndex, process.env.PHASE_RETRIEVAL ?? "hybrid", cwd);
      text = r.claims.length ? memoryText(r.claims) : "No matching Phase memories.";
    } else if (tool === "phase_inspect") {
      const id = String(args.id ?? "");
      if (id.startsWith("M")) {
        const claim = store.getClaim(id);
        if (!claim) throw new Error(`memory not found: ${id}`);
        text = JSON.stringify({ ...claim, freshness: claimFreshness(claim) }, null, 2);
      } else if (id.startsWith("O")) {
        const obs = store.getObservation(id);
        if (!obs) throw new Error(`observation not found: ${id}`);
        text = JSON.stringify(obs, null, 2);
      } else throw new Error("phase_inspect id must start with M or O");
    } else if (tool === "phase_retract") {
      const id = String(args.id ?? "");
      store.retractClaim(id);
      phaseIndex.rebuild(store.listActiveClaims(), store.activeClaimDigest());
      text = `Retracted ${id}.`;
    } else if (tool === "phase_remember") {
      const claim = redactSecrets(String(args.claim ?? ""));
      const id = store.addClaim({ sessionId, claim, evidenceIds: args.evidence_ids ?? [], confidence: args.confidence ?? 1 });
      phaseIndex.addClaim(id, claim);
      phaseIndex.claimDigest = store.activeClaimDigest();
      phaseIndex.calibrateNoise(8);
      phaseIndex.save();
      text = `Stored ${id}.`;
    } else if (tool === "finish") {
      finished = true;
      summary = String(args.summary ?? "");
      text = summary || "finished";
    } else {
      throw new Error(`unknown tool: ${tool}`);
    }
  } catch (error) {
    isError = true;
    text = `ERROR: ${String(error)}`;
  }

  text = redactSecrets(clip(text));
  store.completeAction(toolCallId, { resultText: text, isError });

  if (!["phase_recall", "phase_inspect", "phase_retract", "phase_remember", "finish"].includes(tool)) {
    const git = gitSnapshot(cwd);
    const artifact = artifactSnapshot(cwd, safeArgs);
    observationId = store.addObservation({
      sessionId,
      toolCallId,
      toolName: tool,
      input: safeArgs,
      outputText: text,
      outputSha256: sha256(text),
      rawOutputSha256: sha256(text),
      cwd,
      gitCommit: git.commit,
      gitDirty: git.dirty,
      gitStatusHash: git.statusHash,
      artifactPath: artifact.path,
      artifactSha256: artifact.hash
    });
    text += `\n[phase evidence: ${observationId}]`;
  }

  return { actionId, text, isError, observationId, finished, summary };
}
