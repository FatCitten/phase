# Phase Runtime v0.9 — workflow → fibers → allocation → outcomes

v0.9 pivots Phase away from a repository-governor harness and into a provider-neutral workflow runtime.

## Thesis

An LLM compiles human intent into a workflow. Phase turns the workflow into **fibers**: temporary units of allocated cognition. A tiny Phase TPM model learns to decide how much resource goes where, to which agent, with which tools/context, for how long, and what happens next.

The coding/researching LLM remains the intelligence that performs the work. The SLM is an asset allocator.

```text
human workflow description
          │
          ▼
 workflow compiler LLM
          │
          ▼
     Phase Workflow IR
          │
          ▼
  Phase TPM allocator ───── architecture seed
          │
      allocations
   ┌──────┼──────┐
   ▼      ▼      ▼
 fiber   fiber   fiber
 agent   agent   agent
   │      │      │
   └──────┼──────┘
          ▼
 measurable outcomes
          │
          ▼
 allocator dataset / JIT LoRA
```

## Architecture seed

`seeds/phase-allocator.seed.json` is not project memory. It is the stable scheduling prior that is hashed into experiments and injected into allocator-model training/inference. It contains rules such as:

- human intent dominates allocator preference;
- project facts come from evidence, never allocator weights;
- allocate the smallest likely-sufficient budget;
- increase budget after measurable misses/failures rather than generalized doubt;
- split only when work is independently verifiable;
- preserve repair/integration reserve;
- route opinionated unresolved choices to the human.

Every compiled allocator dataset prepends architecture-seed examples, and every model-policy call receives the seed system prompt.

## Workflow IR

The new primary interface is `phase-workflow-v1`. It is independent of Pi, Codex, Claude, Gemini, OpenCode, Aider, or any particular repository governor.

```bash
phase workflow:init phase-workflow.json .
phase workflow:compile "Build a browser game and validate each subsystem" phase-workflow.json
phase workflow:run phase-workflow.json
```

`workflow:compile` can use any Phase agent adapter as the semantic compiler. `workflow:run` then executes the resulting fibers.

## Fibers

A fiber is not an agent personality. It is an allocation:

```text
objective
agent/backend
context budget
token budget
wall-time budget
tool-call budget
tool capability set
dependencies
validation
termination condition
```

The CLI renders fibers as progress bars. Percentage represents lifecycle completion (queued → allocated → context → running → validating → done/failed), not fabricated estimates of how much coding remains.

## SLM policy

`allocator.policy` may be `heuristic` or `model`.

The model path expects an OpenAI-compatible local endpoint. Its output is constrained by Phase before execution:

- it cannot exceed fiber context/time/tool-call ceilings;
- it cannot allocate tools outside the fiber allowlist;
- it cannot route to an unavailable agent;
- model failure can fall back to the deterministic allocator unless `required=true`.

The model receives a hashed state vector and allocation ceilings, not authority to invent project truth.

## Project geometry

`phase-state-vector-v1` uses deterministic signed feature hashing. Repository-domain anchors occupy substantial vector mass, so otherwise similar tasks in unrelated repositories remain strongly separated. Hard provenance domains from v0.6 remain the security boundary; vector distance is an allocator/research signal, not a security control.

## Research tooling

Every workflow run produces a research directory containing:

- `manifest.json`: protocol versions, architecture-seed hash, workflow hash, platform/runtime metadata, git snapshot;
- `events.ndjson`: append-only event sequence with a SHA-256 hash chain;
- `result.json`: outcome summary, event-chain head, event-log digest.

Across runs:

```bash
phase research:summarize .phase/experiments
phase allocator:dataset .phase/experiments .phase/allocator-dataset
```

The summary reports sample count, pass rate, Wilson 95% confidence interval, and wall-time statistics. The allocator dataset combines stable architecture seeds with measured allocation/outcome examples.

Raw training telemetry uses `phase-genuine-signals-v1`: validation outcome, worker completion, wall-time, wall-budget utilization/remaining budget, and declared context/tool allocations. These algebraic measurements are stored separately from the experiment objective/reward so researchers can change the optimization function without rewriting history.

## JIT allocator training

```bash
phase allocator:jit .phase/experiments .phase/allocator-dataset .phase/models/allocator
```

This compiles measured experiments and runs `training/train_allocator.py` to produce a LoRA adapter. Training is deliberately opt-in and checkpointed: a failed Python/training environment does not destroy the measured dataset.

The target is allocation JSON only. Source code, project facts, and patch generation are explicitly outside the SLM target.

## Compatibility

v0.5–v0.8 harness commands remain available (`phase run`, hidden evaluator isolation, provenance domains, cloud sync, run reports). They are now a compatibility/execution layer beneath the new workflow abstraction rather than the conceptual center of Phase.
