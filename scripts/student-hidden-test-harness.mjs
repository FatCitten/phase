#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { BrainStore } from "../src/store.mjs";
import { PhaseAssociativeIndex, defaultPhaseIndexPath } from "../src/phase-index.mjs";
import { runStudent } from "../src/student-runtime.mjs";

function sha256File(path) { const h = createHash("sha256"); h.update(readFileSync(path)); return h.digest("hex"); }
function run(argv, cwd) { const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return { argv, status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; }
function stableEqual(a, b) { return JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort()); }

const configPath = process.argv[2];
if (!configPath) { console.error("usage: node scripts/student-hidden-test-harness.mjs path/to/task.json"); process.exit(64); }
const absoluteConfigPath = resolve(configPath);
const cfg = JSON.parse(readFileSync(absoluteConfigPath, "utf8"));
const cwd = resolve(cfg.cwd ?? ".");
if ((absoluteConfigPath.startsWith(cwd + "/") || absoluteConfigPath === cwd) && cfg.allow_config_in_worktree !== true) {
  throw new Error("benchmark config must live outside the agent worktree");
}
for (const raw of cfg.hidden_paths ?? []) {
  const p = isAbsolute(raw) ? raw : resolve(cwd, raw);
  if (existsSync(p)) throw new Error(`hidden path is already agent-accessible: ${p}`);
}

const runId = cfg.id ?? `student-${Date.now()}`;
const phaseDir = resolve(cwd, ".phase", "student-benchmark", runId);
mkdirSync(phaseDir, { recursive: true });
const dbPath = cfg.brain_db ? resolve(cfg.brain_db) : join(phaseDir, "brain.sqlite");
const phaseIndexPath = cfg.phase_index ? resolve(cfg.phase_index) : defaultPhaseIndexPath(dbPath);
const resultPath = join(phaseDir, "result.json");

const student = await runStudent({
  cwd,
  task: cfg.prompt,
  dbPath,
  phaseIndexPath,
  baseUrl: cfg.model_url ?? process.env.PHASE_STUDENT_URL ?? "http://127.0.0.1:8080/v1",
  model: cfg.model ?? process.env.PHASE_STUDENT_MODEL ?? "phase-student",
  protocol: cfg.protocol ?? process.env.PHASE_STUDENT_PROTOCOL ?? "json-action",
  maxSteps: Number(cfg.max_steps ?? process.env.PHASE_STUDENT_MAX_STEPS ?? 40)
});

const automaticDeny = [...(cfg.hidden_paths ?? []), ...(cfg.hidden_copies ?? []).flatMap((x) => [x.from, x.to]), ...(cfg.reference_paths ?? [])].map(String);
const denyPatterns = [...new Set([...(cfg.deny_patterns ?? []), ...automaticDeny].filter(Boolean))];
const brain = new BrainStore(dbPath);
const provenanceAudit = brain.audit(denyPatterns);
let indexAudit;
try { const idx = PhaseAssociativeIndex.load(phaseIndexPath); idx.ensureSynced(brain); indexAudit = idx.audit(brain); }
catch (error) { indexAudit = { passed: false, error: String(error) }; }
const audit = { ...provenanceAudit, index: indexAudit, passed: provenanceAudit.passed && indexAudit.passed };
const ledgerHeadBeforeHidden = brain.ledgerHead();
brain.close();

const protectedFiles = [dbPath, phaseIndexPath, ...["-wal", "-shm"].map((s) => dbPath + s)].filter(existsSync);
const before = Object.fromEntries(protectedFiles.map((p) => [p, sha256File(p)]));
for (const p of protectedFiles) chmodSync(p, 0o444);
const installs = [];
if (audit.passed) {
  for (const item of cfg.hidden_copies ?? []) {
    const from = resolve(item.from);
    const to = isAbsolute(item.to) ? item.to : resolve(cwd, item.to);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    installs.push({ from, to });
  }
}
const validations = [];
if (audit.passed && student.finished) {
  for (const command of cfg.validation_commands ?? []) {
    const argv = Array.isArray(command) ? command : ["bash", "-lc", String(command)];
    const result = run(argv, cwd);
    validations.push(result);
    if (result.status !== 0 && cfg.stop_on_failure !== false) break;
  }
}
const after = Object.fromEntries(protectedFiles.map((p) => [p, sha256File(p)]));
const frozenBeforeHiddenTests = stableEqual(before, after);
for (const p of protectedFiles) { try { chmodSync(p, 0o600); } catch {} }
for (const item of installs.slice().reverse()) { try { rmSync(item.to, { recursive: true, force: true }); } catch {} }
for (const raw of cfg.hidden_paths ?? []) { try { rmSync(isAbsolute(raw) ? raw : resolve(cwd, raw), { recursive: true, force: true }); } catch {} }

const result = {
  runId,
  cwd,
  sessionId: student.sessionId,
  ledgerHeadBeforeHidden,
  student,
  audit,
  protectedMemoryArtifacts: protectedFiles,
  frozenBeforeHiddenTests,
  artifactHashesBeforeHidden: before,
  artifactHashesAfterHidden: after,
  hiddenCopies: installs,
  validations,
  passed: student.finished && !student.error && audit.passed && frozenBeforeHiddenTests && validations.every((v) => v.status === 0)
};
writeFileSync(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.passed ? 0 : 2;
