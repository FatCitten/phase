#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function load(path) { return JSON.parse(readFileSync(resolve(path), "utf8")); }
function stats(suite) {
  const rows = suite.results ?? [];
  const passed = rows.filter((r) => r.result?.passed).length;
  const studentRows = rows.map((r) => r.result?.student).filter(Boolean);
  const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  return {
    suiteId: suite.suiteId,
    tasks: rows.length,
    passed,
    passRate: rows.length ? passed / rows.length : 0,
    avgSteps: mean(studentRows.map((s) => Number(s.steps ?? 0))),
    avgModelCalls: mean(studentRows.map((s) => Number(s.telemetry?.modelCalls ?? 0))),
    avgPromptTokens: mean(studentRows.map((s) => Number(s.telemetry?.promptTokens ?? 0))),
    avgCompletionTokens: mean(studentRows.map((s) => Number(s.telemetry?.completionTokens ?? 0))),
    avgToolErrors: mean(studentRows.map((s) => Number(s.telemetry?.toolErrors ?? 0))),
    avgModelLatencyMs: mean(studentRows.map((s) => Number(s.telemetry?.modelLatencyMs ?? 0))),
    avgWallTimeMs: mean(studentRows.map((s) => Number(s.telemetry?.wallTimeMs ?? 0)))
  };
}

const aPath = process.argv[2];
const bPath = process.argv[3];
if (!aPath || !bPath) { console.error("usage: node scripts/compare-students.mjs BASE_SUITE.json DISTILLED_SUITE.json"); process.exit(64); }
const base = stats(load(aPath));
const student = stats(load(bPath));
const delta = {
  passRate: student.passRate - base.passRate,
  avgSteps: student.avgSteps != null && base.avgSteps != null ? student.avgSteps - base.avgSteps : null,
  avgModelCalls: student.avgModelCalls != null && base.avgModelCalls != null ? student.avgModelCalls - base.avgModelCalls : null,
  avgPromptTokens: student.avgPromptTokens != null && base.avgPromptTokens != null ? student.avgPromptTokens - base.avgPromptTokens : null,
  avgCompletionTokens: student.avgCompletionTokens != null && base.avgCompletionTokens != null ? student.avgCompletionTokens - base.avgCompletionTokens : null,
  avgToolErrors: student.avgToolErrors != null && base.avgToolErrors != null ? student.avgToolErrors - base.avgToolErrors : null,
  avgModelLatencyMs: student.avgModelLatencyMs != null && base.avgModelLatencyMs != null ? student.avgModelLatencyMs - base.avgModelLatencyMs : null,
  avgWallTimeMs: student.avgWallTimeMs != null && base.avgWallTimeMs != null ? student.avgWallTimeMs - base.avgWallTimeMs : null
};
const gate = {
  noAccuracyRegression: delta.passRate >= 0,
  accuracyImproved: delta.passRate > 0,
  fewerOrEqualSteps: delta.avgSteps == null ? null : delta.avgSteps <= 0,
  passed: delta.passRate > 0 || (delta.passRate === 0 && (delta.avgSteps ?? 1) < 0)
};
console.log(JSON.stringify({ base, student, delta, gate }, null, 2));
process.exitCode = gate.passed ? 0 : 2;
