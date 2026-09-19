# Phase Harness v0.8 — Cloud + Verification

v0.8 adds a premium WebSocket layer while preserving the v0.7 harness-agnostic local runtime.

## Added

- authenticated `phase-cloud-v1` WebSocket session,
- premium entitlement handshake,
- per-event ACKs,
- private customer telemetry stream,
- separately consented aggregate commercial-data stream,
- de-identified product-log records,
- `phase cloud:dev` reference cloud,
- reproducible WebGPU hack-and-slash orchestration benchmark,
- generated WebGPU Phaseblade demo artifact.

## Cloud event lifecycle

```text
run.started
  ↓
controller.step × N
  ↓
run.completed
```

`metrics` mode sends reduced operational records. `trace` mode is intentionally private and may include repository-sensitive controller results. Commercial aggregate contribution must be independently enabled with `cloud.data_product="aggregate"`.

## WebGPU benchmark result

The included benchmark uses a deterministic, deliberately fallible coding-worker fixture because this release environment has no external agent CLI installed. The direct one-shot worker omits melee damage and fails acceptance. Phase sees the validation failure, delegates one repair, validates again, reviews, consolidates, and passes.

This proves the orchestration/repair mechanism on a nontrivial WebGPU artifact. It does **not** prove that Phase improves the quality, token use, or latency of arbitrary LLM coding agents. Run the same benchmark against Pi/Codex/Claude/Gemini/etc. on real models before making that broader claim.
