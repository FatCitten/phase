#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BrainStore } from "../src/store.mjs";
import { PhaseAssociativeIndex, defaultPhaseIndexPath } from "../src/phase-index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "../src/index.ts");

function sha256File(path) {
  const h = createHash("sha256");
  h.update(readFileSync(path));
  return h.digest("hex");
}

function stableEqual(a, b) {
  return JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());
}

function run(argv, cwd, env = process.env) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { argv, status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const configPath = process.argv[2];
if (!configPath) {
  console.error("usage: node scripts/hidden-test-harness.mjs path/to/task.json");
  process.exit(64);
}
const absoluteConfigPath = resolve(configPath);
const cfg = JSON.parse(readFileSync(absoluteConfigPath, "utf8"));
const cwd = resolve(cfg.cwd ?? ".");
const relativeConfig = absoluteConfigPath.startsWith(cwd + "/") || absoluteConfigPath === cwd;
if (relativeConfig && cfg.allow_config_in_worktree !== true) {
  throw new Error("refusing to start: benchmark config is inside the agent worktree; keep hidden-test metadata outside it (or set allow_config_in_worktree=true explicitly)");
}
const runId = cfg.id ?? `run-${Date.now()}`;
const phaseDir = resolve(cwd, ".phase", "benchmark", runId);
mkdirSync(phaseDir, { recursive: true });
const dbPath = cfg.brain_db ? resolve(cfg.brain_db) : join(phaseDir, "brain.sqlite");
const phaseIndexPath = cfg.phase_index ? resolve(cfg.phase_index) : defaultPhaseIndexPath(dbPath);
mkdirSync(dirname(dbPath), { recursive: true });
mkdirSync(dirname(phaseIndexPath), { recursive: true });
const resultPath = join(phaseDir, "result.json");

for (const hiddenPathRaw of cfg.hidden_paths ?? []) {
  const hiddenPath = isAbsolute(hiddenPathRaw) ? hiddenPathRaw : resolve(cwd, hiddenPathRaw);
  if (existsSync(hiddenPath)) {
    throw new Error(`refusing to start: hidden path is already agent-accessible: ${hiddenPath}`);
  }
}

const piArgs = [cfg.pi_bin ?? "pi", "-p", "-e", extensionPath, ...(cfg.pi_args ?? []), cfg.prompt];
const agent = run(piArgs, cwd, {
  ...process.env,
  PHASE_DB: dbPath,
  PHASE_INDEX_PATH: phaseIndexPath,
  PHASE_AUTO_RECALL: cfg.auto_recall === false ? "0" : "1",
  PHASE_RETRIEVAL: cfg.retrieval_mode ?? process.env.PHASE_RETRIEVAL ?? "hybrid"
});

if (!existsSync(dbPath)) throw new Error("Pi run did not create the Phase database; was the extension loaded?");
const automaticDeny = [
  ...(cfg.hidden_paths ?? []),
  ...(cfg.hidden_copies ?? []).flatMap((item) => [item.from, item.to]),
  ...(cfg.reference_paths ?? [])
].map(String);
const denyPatterns = [...new Set([...(cfg.deny_patterns ?? []), ...automaticDeny].filter(Boolean))];
const brain = new BrainStore(dbPath);
const provenanceAudit = brain.audit(denyPatterns);
const benchmarkSessions = brain.listSessions();
const sessionId = benchmarkSessions.at(-1)?.id ?? null;
const ledgerHeadBeforeHidden = brain.ledgerHead();
let phaseIndexAudit;
try {
  const idx = PhaseAssociativeIndex.load(phaseIndexPath);
  idx.ensureSynced(brain);
  phaseIndexAudit = idx.audit(brain);
} catch (error) {
  phaseIndexAudit = { passed: false, error: String(error) };
}
const audit = { ...provenanceAudit, index: phaseIndexAudit, passed: provenanceAudit.passed && phaseIndexAudit.passed };
brain.close();
const protectedFiles = [dbPath, phaseIndexPath, ...["-wal", "-shm"].map((suffix) => dbPath + suffix)].filter((p) => existsSync(p));
const artifactHashesBeforeHidden = Object.fromEntries(protectedFiles.map((p) => [p, sha256File(p)]));
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
if (audit.passed && agent.status === 0) {
  for (const command of cfg.validation_commands ?? []) {
    const argv = Array.isArray(command) ? command : ["bash", "-lc", String(command)];
    const result = run(argv, cwd);
    validations.push(result);
    if (result.status !== 0 && cfg.stop_on_failure !== false) break;
  }
}

const artifactHashesAfterHidden = Object.fromEntries(protectedFiles.map((p) => [p, sha256File(p)]));
const frozenBeforeHiddenTests = stableEqual(artifactHashesBeforeHidden, artifactHashesAfterHidden);
for (const p of protectedFiles) { try { chmodSync(p, 0o600); } catch {} }
for (const item of installs.slice().reverse()) {
  try { rmSync(item.to, { force: true }); } catch {}
}
for (const hiddenPathRaw of cfg.hidden_paths ?? []) {
  const hiddenPath = isAbsolute(hiddenPathRaw) ? hiddenPathRaw : resolve(cwd, hiddenPathRaw);
  try { rmSync(hiddenPath, { recursive: true, force: true }); } catch {}
}
const result = {
  runId,
  cwd,
  agent: { status: agent.status, stdout: agent.stdout, stderr: agent.stderr },
  audit,
  sessionId,
  ledgerHeadBeforeHidden,
  retrievalMode: cfg.retrieval_mode ?? process.env.PHASE_RETRIEVAL ?? "hybrid",
  protectedMemoryArtifacts: protectedFiles,
  frozenBeforeHiddenTests,
  artifactHashesBeforeHidden,
  artifactHashesAfterHidden,
  hiddenCopies: installs,
  validations,
  passed: agent.status === 0 && audit.passed && frozenBeforeHiddenTests && validations.every((v) => v.status === 0)
};
writeFileSync(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.passed ? 0 : 2;
