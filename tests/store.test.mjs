import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainStore } from "../src/store.mjs";
import { claimFreshness } from "../src/freshness.mjs";
import { sha256 } from "../src/util.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "phase-pi-"));
  const db = join(dir, "brain.sqlite");
  const file = join(dir, "source.txt");
  writeFileSync(file, "alpha\n");
  const store = new BrainStore(db);
  const sessionId = store.startSession({ cwd: dir, gitCommit: "deadbeef" });
  return { dir, db, file, store, sessionId };
}

test("rejects memories without real evidence", () => {
  const x = fixture();
  try {
    assert.throws(() => x.store.addClaim({ sessionId: x.sessionId, claim: "unsupported", evidenceIds: [] }), /ungrounded/);
    assert.throws(() => x.store.addClaim({ sessionId: x.sessionId, claim: "fake receipt", evidenceIds: ["OFAKE"] }), /unknown evidence/);
  } finally { x.store.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("stores claim -> observation lineage and verifies ledger", () => {
  const x = fixture();
  try {
    const o = x.store.addObservation({
      sessionId: x.sessionId, toolCallId: "tc1", toolName: "read", input: { path: x.file },
      outputText: "alpha", outputSha256: sha256("alpha"), rawOutputSha256: sha256("alpha"), cwd: x.dir,
      gitCommit: "deadbeef", artifactPath: x.file, artifactSha256: sha256("alpha\n")
    });
    const m = x.store.addClaim({ sessionId: x.sessionId, claim: "source contains alpha", evidenceIds: [o] });
    const claim = x.store.getClaim(m);
    assert.equal(claim.evidence[0].public_id, o);
    assert.equal(claimFreshness(claim).status, "fresh");
    assert.equal(x.store.verifyLedger().ok, true);
  } finally { x.store.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("marks file-backed memory stale when evidence source changes", () => {
  const x = fixture();
  try {
    const o = x.store.addObservation({
      sessionId: x.sessionId, toolName: "read", input: { path: x.file }, outputText: "alpha",
      outputSha256: sha256("alpha"), rawOutputSha256: sha256("alpha"), cwd: x.dir,
      artifactPath: x.file, artifactSha256: sha256("alpha\n")
    });
    const m = x.store.addClaim({ sessionId: x.sessionId, claim: "source contains alpha", evidenceIds: [o] });
    writeFileSync(x.file, "beta\n");
    assert.equal(claimFreshness(x.store.getClaim(m)).status, "stale");
  } finally { x.store.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("audit catches forbidden hidden-test markers", () => {
  const x = fixture();
  try {
    x.store.addObservation({
      sessionId: x.sessionId, toolName: "bash", input: { command: "cat .hidden-tests/test.py" },
      outputText: "secret assertion", outputSha256: sha256("secret assertion"), rawOutputSha256: sha256("secret assertion"), cwd: x.dir
    });
    const result = x.store.audit([".hidden-tests"]);
    assert.equal(result.passed, false);
    assert.equal(result.violations.length, 1);
  } finally { x.store.close(); rmSync(x.dir, { recursive: true, force: true }); }
});


test("ledger audit detects observation-row tampering", () => {
  const x = fixture();
  try {
    const o = x.store.addObservation({
      sessionId: x.sessionId, toolName: "bash", input: { command: "cat public.txt" },
      outputText: "original evidence", outputSha256: sha256("original evidence"), rawOutputSha256: sha256("original evidence"), cwd: x.dir
    });
    x.store.db.prepare(`UPDATE observations SET output_text='rewritten evidence' WHERE public_id=?`).run(o);
    const verified = x.store.verifyLedger();
    assert.equal(verified.ok, false);
    assert.match(verified.reason, /hash mismatch|does not match/);
  } finally { x.store.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

import { PhaseAssociativeIndex } from "../src/phase-index.mjs";

test("phase-native index retrieves only auditable memory IDs", () => {
  const x = fixture();
  try {
    const o1 = x.store.addObservation({
      sessionId: x.sessionId, toolName: "read", input: { path: x.file }, outputText: "damage service",
      outputSha256: sha256("damage service"), rawOutputSha256: sha256("damage service"), cwd: x.dir
    });
    const m1 = x.store.addClaim({ sessionId: x.sessionId, claim: "DamageService owns authoritative damage processing", evidenceIds: [o1] });
    const o2 = x.store.addObservation({
      sessionId: x.sessionId, toolName: "read", input: { path: x.file }, outputText: "token refresh",
      outputSha256: sha256("token refresh"), rawOutputSha256: sha256("token refresh"), cwd: x.dir
    });
    const m2 = x.store.addClaim({ sessionId: x.sessionId, claim: "AuthService rotates refresh tokens", evidenceIds: [o2] });
    const idx = new PhaseAssociativeIndex({ path: join(x.dir, "index.json") });
    idx.rebuild(x.store.listActiveClaims(), x.store.activeClaimDigest());
    const hit = idx.search("where does authoritative damage happen", 4);
    assert.equal(hit.candidates[0].id, m1);
    assert.ok(hit.candidates.every((c) => /^M[A-Z0-9]+$/.test(c.id)));
    assert.equal(idx.audit(x.store).passed, true);
    assert.notEqual(m1, m2);
  } finally { x.store.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("phase-native index rebuilds when canonical claims change", () => {
  const x = fixture();
  try {
    const idx = new PhaseAssociativeIndex({ path: join(x.dir, "index.json") });
    idx.ensureSynced(x.store);
    const first = idx.claimDigest;
    const o = x.store.addObservation({
      sessionId: x.sessionId, toolName: "read", input: {}, outputText: "movement stamina",
      outputSha256: sha256("movement stamina"), rawOutputSha256: sha256("movement stamina"), cwd: x.dir
    });
    const m = x.store.addClaim({ sessionId: x.sessionId, claim: "MovementService owns stamina drain", evidenceIds: [o] });
    idx.ensureSynced(x.store);
    assert.notEqual(idx.claimDigest, first);
    assert.equal(idx.search("stamina movement", 3).candidates[0].id, m);
  } finally { x.store.close(); rmSync(x.dir, { recursive: true, force: true }); }
});


test("rejects cross-repository evidence at the storage boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "phase-domain-"));
  const a = join(root, "a"), b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
  const store = new BrainStore(join(root, "brain.sqlite"));
  try {
    const sa = store.startSession({ cwd: a });
    const sb = store.startSession({ cwd: b });
    const oa = store.addObservation({
      sessionId: sa, toolName: "read", input: { path: "a.txt" }, outputText: "A fact",
      outputSha256: sha256("A fact"), rawOutputSha256: sha256("A fact"), cwd: a
    });
    assert.throws(() => store.addClaim({ sessionId: sb, claim: "B claims A fact", evidenceIds: [oa] }), /cross-repository evidence forbidden/);

    const bDomain = store.db.prepare(`SELECT repository_id FROM sessions WHERE id=?`).get(sb).repository_id;
    const claimRow = store.db.prepare(`INSERT INTO claims(public_id,claim,confidence,session_id,repository_id,created_at) VALUES(?,?,?,?,?,?)`)
      .run('MTRIGGERTEST', 'direct SQL cross-domain probe', 1, sb, bDomain, new Date().toISOString());
    const obsRow = store.db.prepare(`SELECT id FROM observations WHERE public_id=?`).get(oa);
    assert.throws(() => store.db.prepare(`INSERT INTO claim_evidence(claim_id,observation_id) VALUES(?,?)`).run(Number(claimRow.lastInsertRowid), obsRow.id), /cross-repository evidence forbidden/);
    store.db.prepare(`DELETE FROM claims WHERE public_id='MTRIGGERTEST'`).run();
    assert.equal(store.verifyLedger().ok, true);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
