# Contributing

Phase treats dataset integrity as a compatibility boundary.

Changes to process-event semantics, canonical file membership, hash/seal behavior, Phase ISA encoding, signal semantics, state-vector construction, corpus derivation, or "unobserved vs zero" behavior require tests and an explicit schema/version decision. Never silently reinterpret an existing measurement.

Rules for data-facing changes:

- canonical capture records what happened, not what a heuristic wishes happened;
- do not silently redact, summarize, normalize, or repair canonical bytes;
- derived views must be reproducible from canonical data;
- live/unsealed runs must never be presented as verified corpus members;
- a measured zero and an unobserved value are different data.

Before submitting changes:

```bash
npm test
npm run bench
```
