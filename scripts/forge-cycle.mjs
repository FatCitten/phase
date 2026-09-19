#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileSuiteDataset } from "../src/forge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = process.argv[2];
const outDirArg = process.argv[3];
if (!manifestPath) { console.error("usage: node scripts/forge-cycle.mjs /outside/worktree/teacher-suite.json [forge-output-dir]"); process.exit(64); }
const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
const cwd = resolve(manifest.cwd);
const run = spawnSync(process.execPath, [resolve(here, "suite.mjs"), resolve(manifestPath)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (run.status !== 0) {
  process.stderr.write(run.stderr || run.stdout);
  process.exit(run.status ?? 2);
}
let suiteSummary;
try { suiteSummary = JSON.parse(run.stdout); }
catch { throw new Error(`could not parse suite result: ${run.stdout.slice(0, 1000)}`); }
const suiteOut = resolve(manifest.output_dir ?? join(cwd, ".phase", "suites", suiteSummary.suiteId));
const suiteResultPath = join(suiteOut, "suite-result.json");
const forgeOut = resolve(outDirArg ?? join(suiteOut, "forge"));
const forge = compileSuiteDataset({ suiteResultPath, outDir: forgeOut });
const result = { suiteResultPath, forgeOut, forge, next: {
  qwen: `python training/train_action_model.py ${forge.files.jsonAction}`,
  functiongemma: `python training/train_functiongemma.py ${forge.files.functiongemma}`
} };
writeFileSync(join(forgeOut, "cycle-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
