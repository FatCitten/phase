#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runStudent } from "../src/student-runtime.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
}

const taskFile = arg("--task-file");
const task = arg("--task") ?? (taskFile ? readFileSync(resolve(taskFile), "utf8") : null);
if (!task) {
  console.error("usage: node scripts/student.mjs --task 'fix the bug' [--cwd .] [--model id] [--url http://127.0.0.1:8080/v1] [--protocol json-action|tool-call]");
  process.exit(64);
}

const result = await runStudent({
  cwd: resolve(arg("--cwd", process.cwd())),
  task,
  dbPath: arg("--db"),
  phaseIndexPath: arg("--phase-index"),
  baseUrl: arg("--url", process.env.PHASE_STUDENT_URL ?? "http://127.0.0.1:8080/v1"),
  model: arg("--model", process.env.PHASE_STUDENT_MODEL ?? "phase-student"),
  protocol: arg("--protocol", process.env.PHASE_STUDENT_PROTOCOL ?? "json-action"),
  maxSteps: Number(arg("--max-steps", process.env.PHASE_STUDENT_MAX_STEPS ?? 40)),
  onStep: ({ step, action, result }) => {
    process.stderr.write(`[${step}] ${action.tool} ${JSON.stringify(action.args)}\n${result.text.slice(0, 800)}\n`);
  }
});
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 2;
