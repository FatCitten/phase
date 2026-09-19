import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainStore } from "../src/store.mjs";
import { runStudent } from "../src/student-runtime.mjs";
import { loadPhaseIndexForStore } from "../src/phase-index.mjs";
import { retrieveClaims } from "../src/retrieval.mjs";
import { compileSuiteDataset } from "../src/forge.mjs";
import { sha256 } from "../src/util.mjs";

async function fakeServer(actions) {
  let i = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      const action = actions[Math.min(i++, actions.length - 1)];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(action) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/v1` };
}

test("standalone student can execute a local model policy loop with provenance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phase-student-"));
  const fake = await fakeServer([
    { tool: "write", args: { path: "answer.txt", content: "ok\n" } },
    { tool: "finish", args: { summary: "done" } }
  ]);
  try {
    const result = await runStudent({ cwd: dir, task: "write answer.txt containing ok", dbPath: join(dir, "brain.sqlite"), baseUrl: fake.url, model: "fake", protocol: "json-action", maxSteps: 4 });
    assert.equal(result.finished, true);
    assert.equal(readFileSync(join(dir, "answer.txt"), "utf8"), "ok\n");
    const store = new BrainStore(join(dir, "brain.sqlite"));
    assert.equal(store.status().actions, 2);
    assert.equal(store.verifyLedger().ok, true);
    assert.match(store.listSessionActions(result.sessionId)[0].result_text, /wrote/);
    store.close();
  } finally {
    await new Promise((resolve) => fake.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forge emits only validator-approved actions as positive SLM data", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase-forge-"));
  const db = join(dir, "brain.sqlite");
  const store = new BrainStore(db);
  try {
    const sessionId = store.startSession({ cwd: dir, gitCommit: "abc" });
    store.addObservation({ sessionId, toolName: "__user_prompt__", input: {}, outputText: "fix alpha", outputSha256: sha256("fix alpha"), rawOutputSha256: sha256("fix alpha"), cwd: dir });
    const injected = "- M123 [fresh] AlphaService owns alpha (evidence: O123)";
    store.addObservation({ sessionId, toolName: "__phase_injection__", input: { query: "fix alpha" }, outputText: injected, outputSha256: sha256(injected), rawOutputSha256: sha256(injected), cwd: dir });
    store.addAction({ sessionId, toolCallId: "tc1", toolName: "write", input: { path: "x.txt", content: "alpha" } });
    store.completeAction("tc1", { resultText: "wrote x.txt", isError: false });
    store.endSession(sessionId);
    const head = store.ledgerHead();
    store.close();

    const suite = { suiteId: "s1", brainDb: db, results: [{ task: "t1", result: { passed: true, sessionId, ledgerHeadBeforeHidden: head } }] };
    const suitePath = join(dir, "suite-result.json");
    writeFileSync(suitePath, JSON.stringify(suite));
    const manifest = compileSuiteDataset({ suiteResultPath: suitePath, outDir: join(dir, "forge") });
    assert.equal(manifest.acceptedTasks, 1);
    assert.equal(manifest.acceptedActions, 2); // write + synthetic finish
    const lines = readFileSync(join(dir, "forge", "accepted.json-action.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(JSON.parse(lines[0].messages[2].content).tool, "write");
    assert.match(lines[0].messages[1].content, /AlphaService owns alpha/);
    assert.equal(JSON.parse(lines[1].messages[2].content).tool, "finish");
  } finally {
    try { store.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger detects action input tampering", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase-action-audit-"));
  const store = new BrainStore(join(dir, "brain.sqlite"));
  try {
    const sessionId = store.startSession({ cwd: dir });
    const id = store.addAction({ sessionId, toolCallId: "tc", toolName: "read", input: { path: "public.txt" } });
    store.db.prepare(`UPDATE action_events SET input_json='{"path":"hidden.txt"}' WHERE public_id=?`).run(id);
    const verified = store.verifyLedger();
    assert.equal(verified.ok, false);
    assert.match(verified.reason, /action row/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("standalone student records the exact Phase memory context used for distillation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phase-student-memory-"));
  const db = join(dir, "brain.sqlite");
  const seed = new BrainStore(db);
  const sid = seed.startSession({ cwd: dir });
  const fact = "Project config lives at config/app.cfg";
  const oid = seed.addObservation({ sessionId: sid, toolName: "seed", input: {}, outputText: fact, outputSha256: sha256(fact), rawOutputSha256: sha256(fact), cwd: dir });
  seed.addClaim({ sessionId: sid, claim: fact, evidenceIds: [oid] });
  seed.endSession(sid);
  seed.close();
  const fake = await fakeServer([{ tool: "finish", args: { summary: "done" } }]);
  try {
    const result = await runStudent({ cwd: dir, task: "inspect project config", dbPath: db, baseUrl: fake.url, model: "fake", protocol: "json-action", maxSteps: 2 });
    const store = new BrainStore(db);
    const injections = store.listSessionObservations(result.sessionId).filter((o) => o.tool_name === "__phase_injection__");
    assert.equal(injections.length, 1);
    assert.equal(injections[0].input.step, 1);
    assert.match(injections[0].output_text, /Project config lives/);
    store.close();
  } finally {
    await new Promise((resolve) => fake.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});


test("retrieval enforces repository scope after phase candidate generation", () => {
  const root = mkdtempSync(join(tmpdir(), "phase-scope-"));
  const a = join(root, "repo-a");
  const b = join(root, "repo-b");
  const db = join(root, "brain.sqlite");
  const store = new BrainStore(db);
  try {
    const sa = store.startSession({ cwd: a });
    const ta = "PROJECT alpha config lives at alpha.cfg";
    const oa = store.addObservation({ sessionId: sa, toolName: "seed", input: {}, outputText: ta, outputSha256: sha256(ta), rawOutputSha256: sha256(ta), cwd: a });
    const ma = store.addClaim({ sessionId: sa, claim: ta, evidenceIds: [oa] });
    store.endSession(sa);
    const sb = store.startSession({ cwd: b });
    const tb = "PROJECT beta config lives at beta.cfg";
    const ob = store.addObservation({ sessionId: sb, toolName: "seed", input: {}, outputText: tb, outputSha256: sha256(tb), rawOutputSha256: sha256(tb), cwd: b });
    const mb = store.addClaim({ sessionId: sb, claim: tb, evidenceIds: [ob] });
    store.endSession(sb);
    const idx = loadPhaseIndexForStore(store);
    const ra = retrieveClaims(store, "PROJECT alpha config", 5, idx, "hybrid", a);
    const rb = retrieveClaims(store, "PROJECT beta config", 5, idx, "hybrid", b);
    assert.deepEqual(ra.claims.map((x) => x.public_id), [ma]);
    assert.deepEqual(rb.claims.map((x) => x.public_id), [mb]);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
