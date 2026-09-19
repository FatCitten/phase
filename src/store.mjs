import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso, publicId, repositoryDomainId, sha256, stableJson, tokenize } from "./util.mjs";

export class BrainStore {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        session_file TEXT,
        git_commit_start TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT UNIQUE NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        tool_call_id TEXT,
        tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_text TEXT NOT NULL,
        output_sha256 TEXT NOT NULL,
        raw_output_sha256 TEXT NOT NULL,
        output_truncated INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        git_commit TEXT,
        git_dirty INTEGER NOT NULL DEFAULT 0,
        git_status_hash TEXT,
        artifact_path TEXT,
        artifact_sha256 TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS action_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT UNIQUE NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        tool_call_id TEXT,
        tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_text TEXT,
        result_sha256 TEXT,
        is_error INTEGER,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT UNIQUE NOT NULL,
        claim TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retracted')),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        repository_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retracted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS claim_evidence (
        claim_id INTEGER NOT NULL REFERENCES claims(id),
        observation_id INTEGER NOT NULL REFERENCES observations(id),
        PRIMARY KEY (claim_id, observation_id)
      );
      CREATE TABLE IF NOT EXISTS ledger (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        payload_hash TEXT NOT NULL,
        prev_hash TEXT,
        entry_hash TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT UNIQUE NOT NULL,
        deny_patterns_json TEXT NOT NULL,
        passed INTEGER NOT NULL,
        violations_json TEXT NOT NULL,
        ledger_head TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
      CREATE INDEX IF NOT EXISTS idx_obs_tool ON observations(tool_name);
      CREATE INDEX IF NOT EXISTS idx_action_session ON action_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_action_call ON action_events(tool_call_id);
      CREATE INDEX IF NOT EXISTS idx_claim_status ON claims(status);
    `);
    const ledgerColumns = this.db.prepare(`PRAGMA table_info(ledger)`).all().map((row) => row.name);
    if (!ledgerColumns.includes("payload_json")) {
      this.db.exec(`ALTER TABLE ledger ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'`);
    }
    for (const table of ["sessions", "observations", "claims"]) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      if (!columns.includes("repository_id")) this.db.exec(`ALTER TABLE ${table} ADD COLUMN repository_id TEXT`);
    }
    const sessions = this.db.prepare(`SELECT id,cwd,repository_id FROM sessions`).all();
    const setSessionDomain = this.db.prepare(`UPDATE sessions SET repository_id=? WHERE id=?`);
    for (const row of sessions) if (!row.repository_id) setSessionDomain.run(repositoryDomainId(row.cwd), row.id);
    this.db.exec(`
      UPDATE observations SET repository_id=(SELECT repository_id FROM sessions WHERE sessions.id=observations.session_id) WHERE repository_id IS NULL;
      UPDATE claims SET repository_id=(SELECT repository_id FROM sessions WHERE sessions.id=claims.session_id) WHERE repository_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_session_repository ON sessions(repository_id);
      CREATE INDEX IF NOT EXISTS idx_obs_repository ON observations(repository_id);
      CREATE INDEX IF NOT EXISTS idx_claim_repository ON claims(repository_id);
      CREATE TRIGGER IF NOT EXISTS trg_observation_repository_domain
      BEFORE INSERT ON observations
      BEGIN
        SELECT CASE WHEN NEW.repository_id IS NULL OR NEW.repository_id != (SELECT repository_id FROM sessions WHERE id=NEW.session_id)
          THEN RAISE(ABORT, 'observation repository domain mismatch') END;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_claim_repository_domain
      BEFORE INSERT ON claims
      BEGIN
        SELECT CASE WHEN NEW.repository_id IS NULL OR NEW.repository_id != (SELECT repository_id FROM sessions WHERE id=NEW.session_id)
          THEN RAISE(ABORT, 'claim repository domain mismatch') END;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_claim_evidence_repository_domain
      BEFORE INSERT ON claim_evidence
      BEGIN
        SELECT CASE WHEN (SELECT repository_id FROM claims WHERE id=NEW.claim_id) != (SELECT repository_id FROM observations WHERE id=NEW.observation_id)
          THEN RAISE(ABORT, 'cross-repository evidence forbidden') END;
      END;
    `);
  }

  close() {
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
    this.db.close();
  }

  startSession({ cwd, sessionFile = null, gitCommit = null, repositoryId = null }) {
    const id = publicId("S");
    const domain = repositoryId ?? repositoryDomainId(cwd);
    this.db.prepare(`INSERT INTO sessions(id,cwd,repository_id,session_file,git_commit_start,started_at) VALUES(?,?,?,?,?,?)`)
      .run(id, cwd, domain, sessionFile, gitCommit, nowIso());
    this.#ledger("session_start", id, { cwd, repositoryId: domain, sessionFile, gitCommit });
    return id;
  }

  endSession(id) {
    this.db.prepare(`UPDATE sessions SET ended_at=? WHERE id=?`).run(nowIso(), id);
    this.#ledger("session_end", id, {});
  }

  addObservation(data) {
    const publicIdValue = publicId("O");
    const at = nowIso();
    const session = this.db.prepare(`SELECT cwd,repository_id FROM sessions WHERE id=?`).get(data.sessionId);
    if (!session) throw new Error(`unknown session: ${data.sessionId}`);
    const domain = repositoryDomainId(data.cwd);
    if (domain !== session.repository_id) throw new Error(`observation repository domain mismatch: session=${session.repository_id} observation=${domain}`);
    this.db.prepare(`
      INSERT INTO observations(
        public_id,session_id,tool_call_id,tool_name,input_json,output_text,output_sha256,raw_output_sha256,
        output_truncated,cwd,repository_id,git_commit,git_dirty,git_status_hash,artifact_path,artifact_sha256,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      publicIdValue, data.sessionId, data.toolCallId ?? null, data.toolName,
      stableJson(data.input ?? {}), data.outputText ?? "", data.outputSha256,
      data.rawOutputSha256 ?? data.outputSha256, data.outputTruncated ? 1 : 0,
      data.cwd, domain, data.gitCommit ?? null, data.gitDirty ? 1 : 0, data.gitStatusHash ?? null,
      data.artifactPath ?? null, data.artifactSha256 ?? null, at
    );
    this.#ledger("observation", publicIdValue, {
      sessionId: data.sessionId,
      toolCallId: data.toolCallId ?? null,
      toolName: data.toolName,
      input: data.input ?? {},
      outputSha256: data.outputSha256,
      rawOutputSha256: data.rawOutputSha256 ?? data.outputSha256,
      outputTruncated: Boolean(data.outputTruncated),
      cwd: data.cwd,
      repositoryId: domain,
      gitCommit: data.gitCommit ?? null,
      gitDirty: Boolean(data.gitDirty),
      gitStatusHash: data.gitStatusHash ?? null,
      artifactPath: data.artifactPath ?? null,
      artifactSha256: data.artifactSha256 ?? null,
      createdAt: at
    });
    return publicIdValue;
  }

  addAction({ sessionId, toolCallId = null, toolName, input = {} }) {
    const publicIdValue = publicId("T");
    const at = nowIso();
    this.db.prepare(`INSERT INTO action_events(public_id,session_id,tool_call_id,tool_name,input_json,created_at) VALUES(?,?,?,?,?,?)`)
      .run(publicIdValue, sessionId, toolCallId, toolName, stableJson(input), at);
    this.#ledger("action", publicIdValue, { sessionId, toolCallId, toolName, input, createdAt: at });
    return publicIdValue;
  }

  completeAction(toolCallId, { resultText = "", isError = false } = {}) {
    if (!toolCallId) return null;
    const row = this.db.prepare(`SELECT * FROM action_events WHERE tool_call_id=? ORDER BY id DESC LIMIT 1`).get(toolCallId);
    if (!row) return null;
    const text = String(resultText ?? "");
    const at = nowIso();
    const resultSha256 = sha256(text);
    this.db.prepare(`UPDATE action_events SET result_text=?, result_sha256=?, is_error=?, completed_at=? WHERE id=?`)
      .run(text, resultSha256, isError ? 1 : 0, at, row.id);
    this.#ledger("action_result", row.public_id, { resultSha256, isError: Boolean(isError), completedAt: at });
    return row.public_id;
  }

  listSessions() {
    return this.db.prepare(`SELECT * FROM sessions ORDER BY started_at,id`).all();
  }

  listSessionActions(sessionId) {
    return this.db.prepare(`SELECT * FROM action_events WHERE session_id=? ORDER BY id`).all(sessionId)
      .map((row) => ({ ...row, input: JSON.parse(row.input_json) }));
  }

  listSessionObservations(sessionId) {
    return this.db.prepare(`SELECT * FROM observations WHERE session_id=? ORDER BY id`).all(sessionId)
      .map((row) => ({ ...row, input: JSON.parse(row.input_json) }));
  }

  addClaim({ sessionId, claim, evidenceIds, confidence = 1 }) {
    const clean = String(claim ?? "").trim();
    if (!clean) throw new Error("claim must not be empty");
    if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) {
      throw new Error("Phase refuses ungrounded memory: provide at least one observation ID");
    }
    const session = this.db.prepare(`SELECT repository_id FROM sessions WHERE id=?`).get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    const unique = [...new Set(evidenceIds.map(String))];
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT id,public_id,repository_id FROM observations WHERE public_id IN (${placeholders})`).all(...unique);
    if (rows.length !== unique.length) {
      const found = new Set(rows.map((r) => r.public_id));
      const missing = unique.filter((id) => !found.has(id));
      throw new Error(`unknown evidence ID(s): ${missing.join(", ")}`);
    }
    const foreign = rows.filter((row) => row.repository_id !== session.repository_id);
    if (foreign.length) throw new Error(`cross-repository evidence forbidden: ${foreign.map((row) => row.public_id).join(", ")}`);
    const publicIdValue = publicId("M");
    const at = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`INSERT INTO claims(public_id,claim,confidence,session_id,repository_id,created_at) VALUES(?,?,?,?,?,?)`)
        .run(publicIdValue, clean, Number(confidence), sessionId, session.repository_id, at);
      const claimId = Number(result.lastInsertRowid);
      const link = this.db.prepare(`INSERT INTO claim_evidence(claim_id,observation_id) VALUES(?,?)`);
      for (const row of rows) link.run(claimId, row.id);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    this.#ledger("claim", publicIdValue, { claim: clean, confidence: Number(confidence), evidenceIds: unique, sessionId, repositoryId: session.repository_id, createdAt: at });
    return publicIdValue;
  }

  retractClaim(publicIdValue) {
    const result = this.db.prepare(`UPDATE claims SET status='retracted', retracted_at=? WHERE public_id=? AND status='active'`)
      .run(nowIso(), publicIdValue);
    if (result.changes === 0) throw new Error(`active claim not found: ${publicIdValue}`);
    this.#ledger("claim_retract", publicIdValue, {});
  }

  getObservation(publicIdValue) {
    return this.db.prepare(`SELECT * FROM observations WHERE public_id=?`).get(publicIdValue) ?? null;
  }

  getClaim(publicIdValue) {
    const claim = this.db.prepare(`SELECT c.*, s.cwd AS scope_cwd FROM claims c JOIN sessions s ON s.id=c.session_id WHERE c.public_id=?`).get(publicIdValue);
    if (!claim) return null;
    const evidence = this.db.prepare(`
      SELECT o.* FROM observations o
      JOIN claim_evidence ce ON ce.observation_id=o.id
      JOIN claims c ON c.id=ce.claim_id
      WHERE c.public_id=? ORDER BY o.id
    `).all(publicIdValue);
    return { ...claim, evidence };
  }

  listRecentObservations(limit = 12) {
    return this.db.prepare(`SELECT * FROM observations ORDER BY id DESC LIMIT ?`).all(Math.max(1, Math.min(100, Number(limit))));
  }

  listActiveClaims() {
    return this.db.prepare(`SELECT public_id,claim,confidence,repository_id,created_at FROM claims WHERE status='active' ORDER BY id`).all();
  }

  activeClaimDigest() {
    return sha256(stableJson(this.listActiveClaims().map((row) => ({
      publicId: row.public_id,
      claim: row.claim,
      confidence: Number(row.confidence),
      repositoryId: row.repository_id,
      createdAt: row.created_at
    }))));
  }

  getClaimsByIds(ids, scopeCwd = null) {
    const unique = [...new Set((ids ?? []).map(String))];
    const domain = scopeCwd ? repositoryDomainId(scopeCwd) : null;
    const out = [];
    for (const id of unique) {
      const claim = this.getClaim(id);
      if (claim && claim.status === 'active' && (!domain || claim.repository_id === domain)) out.push(claim);
    }
    return out;
  }

  searchClaims(query, limit = 6, scopeCwd = null) {
    const tokens = tokenize(query).filter((t) => t.length >= 3);
    const domain = scopeCwd ? repositoryDomainId(scopeCwd) : null;
    const rows = domain
      ? this.db.prepare(`SELECT * FROM claims WHERE status='active' AND repository_id=? ORDER BY id DESC LIMIT 1000`).all(domain)
      : this.db.prepare(`SELECT * FROM claims WHERE status='active' ORDER BY id DESC LIMIT 1000`).all();
    const scored = rows.map((row) => {
      const hay = String(row.claim).toLowerCase();
      let score = 0;
      for (const token of tokens) if (hay.includes(token)) score += token.length;
      return { ...row, score };
    }).filter((row) => tokens.length === 0 || row.score > 0)
      .sort((a, b) => b.score - a.score || b.id - a.id)
      .slice(0, Math.max(1, Math.min(20, Number(limit))));
    return scored.map((row) => this.getClaim(row.public_id));
  }

  status() {
    const one = (sql) => Number(this.db.prepare(sql).get().n);
    return {
      sessions: one(`SELECT COUNT(*) n FROM sessions`),
      observations: one(`SELECT COUNT(*) n FROM observations`),
      actions: one(`SELECT COUNT(*) n FROM action_events`),
      claims: one(`SELECT COUNT(*) n FROM claims WHERE status='active'`),
      retracted: one(`SELECT COUNT(*) n FROM claims WHERE status='retracted'`),
      ledgerEntries: one(`SELECT COUNT(*) n FROM ledger`),
      ledgerHead: this.ledgerHead()
    };
  }

  ledgerHead() {
    return this.db.prepare(`SELECT entry_hash FROM ledger ORDER BY seq DESC LIMIT 1`).get()?.entry_hash ?? null;
  }

  verifyLedger() {
    const rows = this.db.prepare(`SELECT * FROM ledger ORDER BY seq`).all();
    let prev = null;
    for (const row of rows) {
      if ((row.prev_hash ?? null) !== prev) return { ok: false, seq: row.seq, reason: "prev_hash mismatch" };
      const payloadJson = row.payload_json ?? "{}";
      if (sha256(payloadJson) !== row.payload_hash) return { ok: false, seq: row.seq, reason: "payload_hash mismatch" };
      const expected = sha256(stableJson({ kind: row.kind, entityId: row.entity_id, payloadHash: row.payload_hash, prevHash: prev, createdAt: row.created_at }));
      if (expected !== row.entry_hash) return { ok: false, seq: row.seq, reason: "entry_hash mismatch" };
      prev = row.entry_hash;
    }

    const observations = this.db.prepare(`SELECT * FROM observations ORDER BY id`).all();
    for (const obs of observations) {
      if (sha256(obs.output_text) !== obs.output_sha256) {
        return { ok: false, reason: "observation output hash mismatch", entityId: obs.public_id };
      }
      const ledgerRow = this.db.prepare(`SELECT payload_json FROM ledger WHERE kind='observation' AND entity_id=? ORDER BY seq LIMIT 1`).get(obs.public_id);
      if (!ledgerRow) return { ok: false, reason: "observation missing from ledger", entityId: obs.public_id };
      const payload = JSON.parse(ledgerRow.payload_json);
      let currentInput;
      try { currentInput = JSON.parse(obs.input_json); } catch { return { ok: false, reason: "observation input JSON invalid", entityId: obs.public_id }; }
      const current = {
        sessionId: obs.session_id,
        toolCallId: obs.tool_call_id ?? null,
        toolName: obs.tool_name,
        input: currentInput,
        outputSha256: obs.output_sha256,
        rawOutputSha256: obs.raw_output_sha256,
        outputTruncated: Boolean(obs.output_truncated),
        cwd: obs.cwd,
        ...(Object.hasOwn(payload, 'repositoryId') ? { repositoryId: obs.repository_id } : {}),
        gitCommit: obs.git_commit ?? null,
        gitDirty: Boolean(obs.git_dirty),
        gitStatusHash: obs.git_status_hash ?? null,
        artifactPath: obs.artifact_path ?? null,
        artifactSha256: obs.artifact_sha256 ?? null,
        createdAt: obs.created_at
      };
      if (stableJson(current) !== stableJson(payload)) {
        return { ok: false, reason: "observation row does not match ledger payload", entityId: obs.public_id };
      }
    }

    const actions = this.db.prepare(`SELECT * FROM action_events ORDER BY id`).all();
    for (const action of actions) {
      const ledgerRow = this.db.prepare(`SELECT payload_json FROM ledger WHERE kind='action' AND entity_id=? ORDER BY seq LIMIT 1`).get(action.public_id);
      if (!ledgerRow) return { ok: false, reason: "action missing from ledger", entityId: action.public_id };
      let input;
      try { input = JSON.parse(action.input_json); } catch { return { ok: false, reason: "action input JSON invalid", entityId: action.public_id }; }
      const initial = { sessionId: action.session_id, toolCallId: action.tool_call_id ?? null, toolName: action.tool_name, input, createdAt: action.created_at };
      if (stableJson(initial) !== stableJson(JSON.parse(ledgerRow.payload_json))) {
        return { ok: false, reason: "action row does not match ledger payload", entityId: action.public_id };
      }
      if (action.completed_at) {
        if (sha256(action.result_text ?? "") !== action.result_sha256) return { ok: false, reason: "action result hash mismatch", entityId: action.public_id };
        const resultLedger = this.db.prepare(`SELECT payload_json FROM ledger WHERE kind='action_result' AND entity_id=? ORDER BY seq DESC LIMIT 1`).get(action.public_id);
        if (!resultLedger) return { ok: false, reason: "completed action missing result ledger", entityId: action.public_id };
        const expectedResult = { resultSha256: action.result_sha256, isError: Boolean(action.is_error), completedAt: action.completed_at };
        if (stableJson(expectedResult) !== stableJson(JSON.parse(resultLedger.payload_json))) return { ok: false, reason: "action result does not match ledger payload", entityId: action.public_id };
      }
    }

    const claims = this.db.prepare(`SELECT * FROM claims ORDER BY id`).all();
    for (const claim of claims) {
      const ledgerRow = this.db.prepare(`SELECT payload_json FROM ledger WHERE kind='claim' AND entity_id=? ORDER BY seq LIMIT 1`).get(claim.public_id);
      if (!ledgerRow) return { ok: false, reason: "claim missing from ledger", entityId: claim.public_id };
      const evidenceIds = this.db.prepare(`
        SELECT o.public_id FROM observations o
        JOIN claim_evidence ce ON ce.observation_id=o.id
        WHERE ce.claim_id=? ORDER BY o.id
      `).all(claim.id).map((row) => row.public_id);
      const claimPayload = JSON.parse(ledgerRow.payload_json);
      const current = { claim: claim.claim, confidence: Number(claim.confidence), evidenceIds, sessionId: claim.session_id, ...(Object.hasOwn(claimPayload, 'repositoryId') ? { repositoryId: claim.repository_id } : {}), createdAt: claim.created_at };
      if (stableJson(current) !== stableJson(claimPayload)) {
        return { ok: false, reason: "claim row does not match ledger payload", entityId: claim.public_id };
      }
      const retract = this.db.prepare(`SELECT 1 ok FROM ledger WHERE kind='claim_retract' AND entity_id=? LIMIT 1`).get(claim.public_id);
      if (claim.status === "retracted" && !retract) return { ok: false, reason: "retracted claim missing ledger event", entityId: claim.public_id };
      if (claim.status === "active" && retract) return { ok: false, reason: "active claim has retraction ledger event", entityId: claim.public_id };
    }

    const crossDomain = this.db.prepare(`
      SELECT c.public_id claim_id,o.public_id observation_id
      FROM claim_evidence ce
      JOIN claims c ON c.id=ce.claim_id
      JOIN observations o ON o.id=ce.observation_id
      WHERE c.repository_id IS NULL OR o.repository_id IS NULL OR c.repository_id != o.repository_id
      LIMIT 1
    `).get();
    if (crossDomain) return { ok: false, reason: "cross-repository evidence link", entityId: crossDomain.claim_id, evidenceId: crossDomain.observation_id };

    return { ok: true, entries: rows.length, head: prev, observations: observations.length, actions: actions.length, claims: claims.length };
  }

  audit(denyPatterns = []) {
    const patterns = [...new Set((denyPatterns ?? []).map((p) => String(p).trim()).filter(Boolean))];
    const violations = [];
    const observations = this.db.prepare(`SELECT public_id,tool_name,input_json,output_text,artifact_path FROM observations ORDER BY id`).all();
    for (const row of observations) {
      const hay = `${row.input_json}\n${row.output_text}\n${row.artifact_path ?? ""}`.toLowerCase();
      for (const pattern of patterns) {
        if (hay.includes(pattern.toLowerCase())) {
          violations.push({ observationId: row.public_id, tool: row.tool_name, pattern });
        }
      }
    }
    const actions = this.db.prepare(`SELECT public_id,tool_name,input_json,result_text FROM action_events ORDER BY id`).all();
    for (const row of actions) {
      const hay = `${row.input_json}\n${row.result_text ?? ""}`.toLowerCase();
      for (const pattern of patterns) {
        if (hay.includes(pattern.toLowerCase())) violations.push({ actionId: row.public_id, tool: row.tool_name, pattern });
      }
    }
    const ledger = this.verifyLedger();
    const passed = ledger.ok && violations.length === 0;
    const auditId = publicId("A");
    this.db.prepare(`INSERT INTO audits(public_id,deny_patterns_json,passed,violations_json,ledger_head,created_at) VALUES(?,?,?,?,?,?)`)
      .run(auditId, stableJson(patterns), passed ? 1 : 0, stableJson(violations), ledger.head ?? null, nowIso());
    return { auditId, passed, denyPatterns: patterns, violations, ledger, ledgerHead: ledger.head ?? null };
  }

  #ledger(kind, entityId, payload) {
    const payloadJson = stableJson(payload);
    const payloadHash = sha256(payloadJson);
    const prevHash = this.ledgerHead();
    const createdAt = nowIso();
    const entryHash = sha256(stableJson({ kind, entityId, payloadHash, prevHash, createdAt }));
    this.db.prepare(`INSERT INTO ledger(kind,entity_id,payload_json,payload_hash,prev_hash,entry_hash,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(kind, entityId, payloadJson, payloadHash, prevHash, entryHash, createdAt);
    return entryHash;
  }
}
