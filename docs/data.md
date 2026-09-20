# Data integrity model

The dataset is Phase's primary asset. Phase therefore uses a one-way data hierarchy.

```text
canonical measurement
      ↓
derived human view
      ↓
derived training view
      ↓
experiment objective / reward
```

Nothing below a layer may rewrite the layer above it.

## Canonical run

`workflow.json`, `symbols.ndjson`, `state.phasebin`, `control.phasebin`, and `signals.phasebin` are canonical. `manifest.json` records a SHA-256 digest for each; `SEALED` records the manifest digest.

Every `.phasebin` record has a CRC32 so local corruption can be located before file-level SHA verification.

`events.ndjson` and `result.json` are convenience views and are explicitly marked derived.

## Null is data

A zero means a measured zero. An unavailable measurement is not a zero. Agent adapters that cannot expose exact input tokens, output tokens, retries, or context misses leave those fields unobserved.

## Corpus

`phase corpus` verifies every source run before indexing it. The corpus stores manifest hashes and canonical stream hashes, deduplicates identical sealed runs, rejects corrupt runs in strict mode, and creates `allocation-episodes.ndjson` by decoding the raw buses.

An allocation episode contains:

```text
allocator state vector
→ route / allocation / capability instructions
→ measured validation + timing outcome
```

The derived episode can always be regenerated from sealed source runs.

## Rewards are not raw data

A scalar utility such as "validated progress per resource" is a research hypothesis. It belongs in analysis/training configuration, not in canonical capture. This permits future experiments to change objectives without relabeling history.
