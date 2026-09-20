# Phase 1.0

**Phase treats agentic work as resource flow.**

A project can be much larger than any model's context window. Phase compiles a human workflow into temporary **fibers**, allocates agents/context/tools/time to those fibers, and records the resulting execution as a small machine-readable instruction and signal stream. A tiny TPM/allocator model can then learn how to spend expensive intelligence from measured outcomes instead of learning project facts.

```text
human workflow
     │
     ▼
workflow compiler LLM
     │
     ▼
Phase Workflow IR
     │
     ▼
TPM allocator SLM ─── Phase architecture seed
     │
     ▼
Phase ISA
     │
 ┌───┼────┐
 ▼   ▼    ▼
fiber fiber fiber
 │    │    │
agent agent agent
 └────┼────┘
      ▼
state / control / signal buses
      ▼
sealed research corpus
```

## What is canonical

Phase 1.0 makes a hard distinction between **measurement** and **interpretation**.

Each completed run is sealed with hashes and contains:

```text
workflow.json       exact workflow input
symbols.ndjson      symbol dictionary
state.phasebin      allocator input state
control.phasebin    allocations and execution instructions
signals.phasebin    measured outcomes
manifest.json       hashes + run metadata
SEALED              manifest digest
events.ndjson       derived human-readable event view
result.json         derived summary
```

The three `.phasebin` buses use fixed-width 32-byte records with per-record CRC32. The run manifest SHA-256 seals every canonical file. Training examples are reconstructed from those buses; event prose and scalar rewards are never required.

**Missing telemetry stays missing.** An unobserved token count/context miss/retry is `null`, not a fabricated zero.

## Install

Requires Node.js 22.19+.

```bash
npm install
npm link
phase --help
```

## Use

Create a workflow:

```bash
phase init phase-workflow.json .
```

Or have an LLM compile a natural-language workflow:

```bash
phase compile "Build the project, split independently verifiable work, and return subjective decisions to me"
```

Run it:

```bash
phase run phase-workflow.json
```

Watch raw Phase instructions/signals in real time:

```bash
phase run phase-workflow.json --raw
```

Inspect a sealed run:

```bash
phase trace .phase/experiments/<run>
phase trace .phase/experiments/<run> --state
phase raw   .phase/experiments/<run> signals --hex
phase verify .phase/experiments/<run>
phase replay .phase/experiments/<run>
```

Build a content-addressed corpus from sealed runs:

```bash
phase corpus .phase/experiments .phase/corpus
phase verify .phase/corpus
```

Train the allocator view:

```bash
phase train .phase/experiments .phase/models/allocator
```

## Fibers

A fiber is a temporary allocation of cognition, not an agent identity.

```text
⠸ F1       █████████████░░░░░░░░░░░  55%  renderer   codex working
✓ F2       ████████████████████████ 100%  tests      validated
```

Progress is lifecycle state (`queued → allocated → context → running → validating → done`), not a fabricated estimate of coding completion.

## Phase ISA

The allocator ultimately controls a tiny instruction vocabulary:

```asm
FORK     F17
ROUTE    F17, codex
ALLOC    F17, CONTEXT_TOKENS, 8192
ALLOC    F17, WALL_MS, 120000
GRANT    F17, read
GRANT    F17, edit
RUN      F17
GATE     F17, 3
RELEASE  F17
```

Fibers return genuine signal packets such as validation pass/fail, wall time, allocated context/tool budget, context misses when observable, retries when observable, and human requests when observable.

See [docs/isa.md](docs/isa.md) and [docs/data.md](docs/data.md).

## Research question

Phase does not attempt to make the coding model itself smarter. The core question is:

> Can a project teach a small allocator how to spend fixed pools of context, model calls, tools, time, money, and human attention more effectively than a static policy?

The intended comparison is always under matched resource pools: heuristic allocator vs learned allocator, measured by validated project progress and the raw resources actually observed.

## Design invariants

- Human intent and explicit constraints outrank allocator preference.
- Project truth lives in current evidence, not TPM weights.
- The allocator may suggest resource decisions; the runtime clamps them to declared capabilities and ceilings.
- Canonical data records what happened, not what Phase wishes had happened.
- Derived rewards/objectives are versioned transforms and may be replaced without rewriting raw runs.
- Repository provenance and OS isolation remain hard boundaries underneath the allocator.

Phase 0.x explored hidden-test isolation, provenance, harness adapters, recovery, cloud telemetry, and workflow allocation. That archaeology is preserved in Git history; 1.0 presents one public abstraction: **an SLM OS for measurable cognitive resource allocation.**
