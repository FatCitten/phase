import { loadPhaseIndexForStore } from "./phase-index.mjs";
import { tokenize } from "./util.mjs";

export function retrieveClaims(store, query, limit = 6, phaseIndex = null, mode = process.env.PHASE_RETRIEVAL ?? "hybrid", scopeCwd = null) {
  const selected = String(mode).toLowerCase();
  if (selected === "lexical") return { claims: store.searchClaims(query, limit, scopeCwd), backend: "lexical", phase: null };
  const idx = phaseIndex ?? loadPhaseIndexForStore(store);
  const phase = idx.search(query, Math.min(128, Math.max(limit * 16, 64)));
  const phaseScore = new Map(phase.candidates.map((x) => [x.id, x.score]));
  const qTokens = tokenize(query).filter((t) => t.length >= 4);
  const claims = store.getClaimsByIds(phase.candidates.map((x) => x.id), scopeCwd)
    .map((claim) => {
      const hay = String(claim.claim).toLowerCase();
      let lexical = 0;
      for (const token of qTokens) if (hay.includes(token)) lexical += Math.min(12, token.length);
      return { claim, rankScore: lexical * 4 + Number(phaseScore.get(claim.public_id) ?? 0) };
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .map((x) => x.claim);
  if (selected === "phase") return { claims: claims.slice(0, limit), backend: "phase", phase };
  const maxNoise = Number(process.env.PHASE_MAX_NOISE ?? 0.65);
  const healthy = Number(idx.noiseFloor ?? Infinity) <= maxNoise;
  if (healthy && claims.length >= limit) return { claims: claims.slice(0, limit), backend: "phase-healthy", phase };
  const seen = new Set(claims.map((c) => c.public_id));
  const fallback = store.searchClaims(query, limit, scopeCwd).filter((c) => !seen.has(c.public_id));
  return {
    claims: [...claims, ...fallback].slice(0, limit),
    backend: healthy ? (claims.length ? "hybrid" : "lexical-fallback") : "hybrid-degraded",
    phase
  };
}
