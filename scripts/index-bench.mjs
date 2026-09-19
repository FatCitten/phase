#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PhaseAssociativeIndex } from "../src/phase-index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../results/index-bench.json");
const loads = (process.env.PHASE_BENCH_LOADS ?? "100,300,500,1000").split(",").map(Number).filter((n) => n > 0);
const trialsMax = Number(process.env.PHASE_BENCH_TRIALS ?? 100);

function tokens(text) {
  return [...new Set(String(text).toLowerCase().match(/[a-z0-9_./:-]{4,}/g) ?? [])];
}

function rerank(query, claims, phase) {
  const q = tokens(query);
  const phaseScore = new Map(phase.candidates.map((x) => [x.id, x.score]));
  return claims
    .filter((c) => phaseScore.has(c.public_id))
    .map((claim) => {
      const hay = claim.claim.toLowerCase();
      let lexical = 0;
      for (const token of q) if (hay.includes(token)) lexical += Math.min(12, token.length);
      return { id: claim.public_id, score: lexical * 4 + (phaseScore.get(claim.public_id) ?? 0) };
    })
    .sort((a, b) => b.score - a.score);
}

const rows = [];
for (const n of loads) {
  const idx = new PhaseAssociativeIndex();
  const claims = Array.from({ length: n }, (_, i) => ({
    public_id: `M${String(i).padStart(8, "0")}`,
    claim: `Module UniqueHandler${i} owns subsystem FeatureGate${i}`
  }));
  const buildStart = performance.now();
  idx.rebuild(claims, `synthetic-${n}`);
  const buildMs = performance.now() - buildStart;
  let included = 0;
  let correct = 0;
  const trials = Math.min(n, trialsMax);
  const queryStart = performance.now();
  for (let i = 0; i < trials; i++) {
    const target = (i * 37) % n;
    const query = `FeatureGate${target} subsystem`;
    const phase = idx.search(query, 128);
    if (phase.candidates.some((x) => x.id === claims[target].public_id)) included++;
    if (rerank(query, claims, phase)[0]?.id === claims[target].public_id) correct++;
  }
  const queryMs = (performance.now() - queryStart) / trials;
  const miss = idx.recall("t:definitelyunknownthing");
  rows.push({
    claims: n,
    cues: idx.stats().cues,
    fixedVectorBytes: idx.stats().fixedVectorBytes,
    buildMs,
    queryMsPer: queryMs,
    candidateRecall: included / trials,
    boundedRerankAccuracy: correct / trials,
    noiseFloor: idx.noiseFloor,
    effectiveGate: idx.effectiveGate,
    unknownConfidence: miss.confidence,
    unknownHit: miss.hit,
    hybridWouldDegrade: idx.noiseFloor > Number(process.env.PHASE_MAX_NOISE ?? 0.65)
  });
  console.log(rows.at(-1));
}

const result = {
  kind: "synthetic capacity smoke benchmark",
  note: "Not a coding-task quality benchmark. It stresses exact structural cue retrieval under growing superposition load.",
  generatedAt: new Date().toISOString(),
  parameters: new PhaseAssociativeIndex().stats(),
  rows
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`wrote ${outPath}`);
