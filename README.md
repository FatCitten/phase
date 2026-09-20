# Phase v0.9

**Describe the workflow. Phase learns how to allocate cognition.**

Phase is now a provider-neutral workflow runtime. A capable LLM can compile human intent into a small workflow graph; Phase turns that graph into **fibers** and allocates agents, context, tools, time, and budget to each fiber. A tiny Phase TPM/allocator model can then be trained from measured outcomes instead of being trained to write code or memorize project truth.

```text
human description
      │
      ▼
workflow compiler LLM
      │
      ▼
 Phase Workflow IR
      │
      ▼
Phase TPM allocator  ◄── baked architecture seed
      │
 ┌────┼────┐
 ▼    ▼    ▼
fiber fiber fiber
 │     │     │
agent agent agent
 │     │     │
 └─────┼─────┘
       ▼
measured outcomes
       │
       ▼
allocator dataset / JIT LoRA
```

A fiber is a temporary allocation of cognition, not an agent personality. The CLI treats fibers like real progress units:

```text
⠸ F1       █████████████░░░░░░░░░░░  55%  renderer       codex working
✓ F2       ████████████████████████ 100%  schema tests    validated
⠸ F3       ████░░░░░░░░░░░░░░░░░░░  18%  combat         8192ctx
```

The percentage is lifecycle progress (queued → allocated → context → running → validating → done), not a fabricated estimate of coding completion.

## Start with a workflow

Requires Node.js 22+.

```bash
npm install
npm link

phase workflow:init phase-workflow.json .
```

Or let any supported agent compile a natural-language workflow into Phase IR:

```bash
phase workflow:compile \
  "Build a WebGPU game. Split rendering and combat into verifiable work. Ask me about subjective game feel." \
  phase-workflow.json
```

Then execute it:

```bash
phase workflow:run phase-workflow.json
```

The same adapter layer supports Pi, Codex CLI, Claude Code, Gemini CLI, OpenCode, Aider, generic argv programs, and external JSON manifests:

```bash
phase agents
```

## The allocator SLM

Phase's local model is a **TPM / asset manager**, not a coder and not project memory.

It receives constrained state and answers questions of the form:

> How much resource, where, for which fiber, using which agent/tools, for how long, then what?

The baked prior lives in:

```text
seeds/phase-allocator.seed.json
seeds/phase-allocator.examples.jsonl
```

Its core rules include:

- human intent dominates allocator preference;
- project facts come from evidence, never allocator weights;
- allocate the smallest likely-sufficient resource budget;
- increase allocation after measurable misses or failed validation, not generalized doubt;
- split only when work is independently verifiable;
- reserve capacity for repair and integration;
- escalate subjective unresolved decisions to the human.

Every allocator experiment records the seed hash. Every compiled training dataset includes the seed examples. Model inference receives the same seed as its system prior.

### Deterministic control condition

```json
{
  "allocator": {
    "policy": "heuristic"
  }
}
```

### Local SLM policy

Serve a trained Phase allocator behind an OpenAI-compatible endpoint:

```json
{
  "allocator": {
    "policy": "model",
    "base_url": "http://127.0.0.1:8080/v1",
    "model": "phase-tpm-allocator",
    "required": false
  }
}
```

Phase clamps model output to the fiber's declared ceilings and allowed capabilities before execution. If the model endpoint fails, it can fall back to the deterministic allocator unless `required` is true.

## Workflow IR

Example:

```json
{
  "schema": "phase-workflow-v1",
  "id": "game",
  "cwd": ".",
  "objective": "Ship a small WebGPU hack-and-slash.",
  "constraints": ["Use WebGPU directly"],
  "decisions": ["Subjective game-feel choices return to the human"],
  "defaults": {
    "agent": "auto",
    "budget": {
      "tokens": 24000,
      "context_tokens": 12000,
      "wall_ms": 900000,
      "tool_calls": 40
    }
  },
  "fibers": [
    {
      "id": "F1",
      "objective": "Build renderer and movement.",
      "depends_on": [],
      "tools": ["read", "edit", "test"],
      "validation": ["npm test"]
    },
    {
      "id": "F2",
      "objective": "Add melee combat.",
      "depends_on": ["F1"],
      "tools": ["read", "edit", "test"],
      "validation": ["npm test"]
    }
  ]
}
```

`wall_ms` is enforced as the worker timeout. Context/token/tool-call budgets are first-class research/allocation fields; exact enforcement depends on the selected agent adapter. Generic third-party CLIs may only receive those values as allocation instructions until their adapter exposes hard resource controls.

## Project geometry

Phase encodes allocator state into `phase-state-vector-v1` using deterministic signed feature hashing. Repository-domain anchors carry substantial vector mass, so otherwise similar tasks in unrelated repositories are strongly separated for scheduling/training purposes.

This is **not** a security boundary. v0.6's hard repository provenance domains and OS isolation remain the security mechanisms.

## Research-quality run artifacts

Each workflow run writes:

```text
.phase/experiments/<run>/
  manifest.json
  events.ndjson
  result.json
```

The manifest records protocol versions, workflow hash, architecture-seed hash, platform/runtime information, and git snapshot. Events form a SHA-256 hash chain. `result.json` records the event-chain head and full event-log digest.

Verify an experiment:

```bash
phase research:verify .phase/experiments/<run>
```

Summarize repeated experiments:

```bash
phase research:summarize .phase/experiments
```

The summary includes sample count, pass rate, Wilson 95% confidence interval, and wall-time statistics.

Compile allocator training data from measured runs:

```bash
phase allocator:dataset .phase/experiments .phase/allocator-dataset
```

The output combines the stable Phase architecture seeds with measured:

```text
state vector → allocation → outcome
```

examples.

Phase stores raw `phase-genuine-signals-v1` measurements separately from the scalar experiment objective. Validation, worker completion, wall time, budget utilization, and allocation sizes remain inspectable even if you later change the reward function.

## JIT allocator training

With the Python training dependencies installed:

```bash
phase allocator:jit \
  .phase/experiments \
  .phase/allocator-dataset \
  .phase/models/allocator
```

This trains a LoRA allocator with `training/train_allocator.py`. The target is allocation JSON only. Code, patches, and canonical project facts are deliberately outside the training target.

## Agent skill

A generic Phase skill is included at:

```bash
phase skill
```

It teaches an agent to behave as an execution fiber: follow the allocated objective, avoid private doctrine, ground claims in current evidence, and return only the concrete result/validation/blocker needed for another fiber to continue.

## Compatibility layer

The v0.5–v0.8 harness is still included and tested:

- OS-level worker isolation;
- repository-scoped provenance domains;
- hidden evaluator firewall;
- premium WebSocket telemetry;
- run reports and data export;
- Pi/Codex/Claude/Gemini/OpenCode/Aider/generic adapters.

Existing commands such as `phase run`, `phase ui`, and `phase cloud:dev` continue to work. They are now execution/compatibility infrastructure beneath the workflow/fiber abstraction rather than the conceptual center of Phase.

See `PHASE-RUNTIME-v0.9.md` for the architecture and experimental model.
