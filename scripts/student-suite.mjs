#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const harness = resolve(here, "student-hidden-test-harness.mjs");
const manifestPath = process.argv[2];
if (!manifestPath) { console.error("usage: node scripts/student-suite.mjs /outside/worktree/suite.json"); process.exit(64); }
const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
const cwd = resolve(manifest.cwd);
const suiteId = manifest.id ?? `student-suite-${Date.now()}`;
const outputDir = resolve(manifest.output_dir ?? join(cwd, ".phase", "student-suites", suiteId));
mkdirSync(outputDir, { recursive: true });
const brainDb = resolve(manifest.brain_db ?? join(outputDir, "brain.sqlite"));
const phaseIndex = `${brainDb}.phase-index.json`;
const temp = mkdtempSync(join(tmpdir(), "phase-student-suite-"));
const results = [];
let failed = false;
try {
  for (let i = 0; i < manifest.tasks.length; i++) {
    const task = JSON.parse(readFileSync(resolve(manifest.tasks[i]), "utf8"));
    Object.assign(task, {
      cwd: task.cwd ? resolve(task.cwd) : cwd,
      brain_db: brainDb,
      phase_index: phaseIndex,
      id: task.id ?? `${suiteId}-${String(i + 1).padStart(3, "0")}`,
      model_url: task.model_url ?? manifest.model_url,
      model: task.model ?? manifest.model,
      protocol: task.protocol ?? manifest.protocol,
      max_steps: task.max_steps ?? manifest.max_steps
    });
    const generated = join(temp, `${i}.json`);
    writeFileSync(generated, JSON.stringify(task, null, 2));
    const run = spawnSync(process.execPath, [harness, generated], { encoding: "utf8" });
    let parsed;
    try { parsed = JSON.parse(run.stdout); } catch { parsed = { passed: false, parseError: true, stdout: run.stdout, stderr: run.stderr }; }
    results.push({ task: task.id, status: run.status, result: parsed });
    if (run.status !== 0 || !parsed.passed) { failed = true; if (manifest.stop_on_failure !== false) break; }
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
const summary = { suiteId, cwd, brainDb, phaseIndex, model: manifest.model, protocol: manifest.protocol, tasksRequested: manifest.tasks.length, tasksCompleted: results.length, passed: !failed && results.length === manifest.tasks.length, results };
const out = join(outputDir, "suite-result.json");
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.passed ? 0 : 2;
