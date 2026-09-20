# Research workflow

1. Define matched workflows and resource ceilings.
2. Run deterministic heuristic allocation as a control condition.
3. Seal every run before analysis.
4. Build a corpus only from verified runs.
5. Train or adapt the TPM on derived allocation episodes.
6. Evaluate on held-out workflows/repositories under the same resource pools.
7. Report raw resource measurements and confidence intervals; do not report only a scalar reward.

Recommended primary outcome: validated project progress under matched total resources. Secondary outcomes include wall time, tool calls, observed token use where adapters expose it, validation failures, retries, context misses, and human interventions.

Phase's current 96-dimensional state vector is deterministic signed feature hashing with strong repository-domain anchors. The hard security boundary remains repository provenance/isolation, not vector distance.
