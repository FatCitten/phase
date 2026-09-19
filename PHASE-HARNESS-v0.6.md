# Phase Harness v0.6 — System Design

## Thesis

Agentic coding has two separable problems:

1. **coding intelligence** — understanding and changing code;
2. **harness intelligence** — deciding what to inspect, when to delegate, how to verify, when to repair, when to stop, and what experience to retain.

Phase v0.6 owns the second problem.

```text
                    PHASE HARNESS
        ┌────────────────────────────────┐
 task ─►│ repository governor             │
        │ provenance + memory             │
        │ worker adapters                 │
        │ verification firewall           │
        │ visual run graph                │
        │ trajectory/data compiler        │
        └──────────────┬─────────────────┘
                       │
              interchangeable worker
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
         Pi          Codex      other agent
                       │
                       ▼
                   repository
```

The worker can become dramatically better without invalidating Phase. Better coding models simply become better interchangeable execution engines.

## Native execution record

Phase treats a run as a state machine, not a transcript:

```text
State_t → Behavior_t → Outcome_t → Verification_t
```

Canonical behaviors:

```text
INSPECT
DELEGATE
VALIDATE
REPAIR
REVIEW
CONSOLIDATE
FINISH
```

Raw reads/greps/edits remain available underneath as provenance, but humans and the local governor operate at the behavior level.

## Evaluation firewall

Hidden evaluation is a lifecycle boundary, not a prompt convention.

```text
AGENT LIFETIME                          EVALUATOR LIFETIME

 task                                      hidden assets
  │                                             │
  ▼                                             │
 controller                                    │
  │                                             │
 worker                                         │
  │                                             │
 public checks                                  │
  │                                             │
 terminate                                     │
  ├──── audit provenance                        │
  ├──── freeze memory                           │
  │                                             ▼
  └──────────────────────────── FIREWALL ── install
                                                │
                                           hidden checks
                                                │
                                         verify brain hash
                                                │
                                            cleanup
```

A human may inspect the hidden evaluation result afterward. In v0.6, hidden runs are fail-closed behind a Linux user/mount-namespace sandbox: the repository is writable, required runtimes are selectively bound read-only, host `/proc` is absent, and capabilities are dropped before the worker executes. Operator/evaluator assets are outside the worker filesystem namespace.

## Provenance domains

Phase no longer treats repository scope as a retrieval-time string filter. Repository identity is stored as a domain on sessions, observations, and claims.

```text
repository domain R...
   ├── session S...
   │    ├── observation O...
   │    └── claim M...
   │          └── evidence must also be R...
```

Application checks reject domain mismatches, SQLite triggers enforce the invariant below the application layer, and ledger verification rejects any surviving cross-domain evidence edge. This prevents a memory scoped to repository B from being grounded in observations captured from repository A.

## Visual model

The visual UI must preserve three zoom levels:

### Level 0 — behavior

```text
INSPECT → DELEGATE → VALIDATE ✕ → REPAIR → VALIDATE ✓ → REVIEW → FINISH
```

### Level 1 — evaluation and resources

- worker/model
- cloud calls
- repairs
- public/hidden pass rate
- wall time
- provenance health
- memory reuse

### Level 2 — raw evidence

- tool/action receipts
- public output
- worker summaries
- diffs for the private operator view
- grounded memory provenance

The default report intentionally keeps the first screen at Levels 0–1.

## Data products

### Behavior corpus — default

Useful for governor SLM/LLM training:

```json
{
  "state": {
    "validationAttempted": true,
    "validationPassed": false,
    "workerRuns": 1,
    "repairs": 0
  },
  "target": {
    "behavior": "repair"
  }
}
```

No patch target is required.

### Outcome corpus — default

Useful for routing, reward modeling, and cost optimization:

```json
{
  "passed": true,
  "worker": "codex",
  "cloudCalls": 2,
  "repairs": 1,
  "steps": 8,
  "publicPassed": true,
  "hiddenPassed": true
}
```

### Rich full trajectory — explicit private opt-in

Useful for larger-model training, critics, patch models, and research. This can contain repository-sensitive data and is never the default export.

## Why the dataset compounds

Successful runs provide demonstrations.

Failed runs provide counterfactuals:

```text
state: tests failing after worker change
bad behavior: finish
better behavior: repair
```

Repeated runs can train:

- behavior policies,
- model routers,
- context selectors,
- retry/repair policies,
- stopping models,
- critics/verifiers,
- cost-aware orchestration,
- eventually coding models when users explicitly opt into rich traces.

## Product boundary

Phase should avoid becoming another editor or another cloud coding model.

Phase owns:

- harness configuration,
- worker adapters,
- run lifecycle,
- auditability,
- hidden evaluation,
- memory,
- visualization,
- trajectory compilation,
- dataset management,
- governor training/evaluation.

Workers own:

- code understanding,
- patch synthesis,
- difficult implementation reasoning.

That boundary keeps the product simple while allowing the data and governor to become increasingly sophisticated.
