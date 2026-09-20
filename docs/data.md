# Data integrity model

The dataset is Phase's primary asset. The runtime therefore uses a one-way hierarchy:

```text
raw measured bytes / events
        ↓
derived operational views
        ↓
derived research/training views
        ↓
experiment objective / reward
```

Nothing below a layer may rewrite the layer above it.

## Canonical process run

For the beta process runtime, canonical data is:

- `command.json` — immutable launch specification
- `events.ndjson` — ordered, SHA-256 hash-chained measurements and control requests
- `stdout.raw` — byte-exact child stdout
- `stderr.raw` — byte-exact child stderr

At exit, `process-manifest.json` records SHA-256 and byte size for every canonical file plus the final event-chain head. `SEALED` stores the manifest digest.

`meta.json` is operational state and is intentionally not canonical.

Output events contain offsets, byte lengths, and hashes into the raw stream files rather than rewriting the text into a second source of truth.

## Canonical allocator research run

The Phase ISA research path continues to use:

- `workflow.json`
- `symbols.ndjson`
- `state.phasebin`
- `control.phasebin`
- `signals.phasebin`

Each `.phasebin` record has a CRC32 and the sealed research manifest records file-level SHA-256 hashes. Those files remain the canonical source for allocator episodes.

## Null is data

A zero means a measured zero. An unavailable measurement is not a zero. Unsupported process counters, unavailable token counts, missing context-miss telemetry, and other unobserved quantities stay `null` or absent.

## Process corpus

`phase corpus` verifies sealed process runs before indexing them. Live/unsealed runs are explicitly skipped. Corrupt sealed runs are rejected in strict mode.

The corpus is content-addressed by source manifest hashes. It does not copy, normalize, summarize, or repair canonical run bytes.

```text
sealed process run
      ↓ verify
process-runs.ndjson
      ↓
sealed corpus index
```

## Allocator corpus

`phase corpus --research` builds the older allocator research view. Allocation episodes are reconstructed from state/control/signal buses:

```text
allocator state vector
→ route / allocation / capability instructions
→ measured validation + timing outcome
```

The derived episode can always be regenerated from the sealed source run.

## Rewards are not raw data

A scalar utility such as "validated progress per resource" is a research hypothesis. It belongs in analysis/training configuration, not canonical capture. Future experiments may change objectives without relabeling history.
