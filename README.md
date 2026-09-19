# Phase Harness v0.7

**Make coding agents observable, testable, replayable, and training-ready without building a harness.**

Phase sits above Pi, Codex, Claude Code, Gemini CLI, OpenCode, Aider, or any non-interactive coding-agent harness. The cloud agent still writes code. Phase owns the repository workflow around it:

```text
TASK
  │
  ▼
INSPECT ──► DELEGATE ──► VALIDATE ──┐
                           │ fail    │ pass
                           ▼         ▼
                         REPAIR    REVIEW
                           │         │
                           └──────► CONSOLIDATE ──► FINISH

          agent-visible │ hidden-evaluator
                        │ firewall
                        ▼
                 HIDDEN VALIDATION
```

Every run produces four things automatically:

1. a **visual run graph** for humans,
2. an **auditable provenance ledger**,
3. a **hidden-test firewall report**, and
4. **validated training data** describing repository-management behavior.

Phase does **not** train the local governor to write patches. It distills how successful coding agents operate repositories: when to inspect, delegate, validate, repair, review, consolidate, and finish.

---

## 30-second workflow

Requires Node.js 22+, Git, and Linux user/mount namespaces for hidden-evaluator runs.

```bash
npm install
npm link
node scripts/install.mjs --global   # optional Pi instrumentation

# From your repository, write the operator config OUTSIDE the repo.
phase init ../my-task.phase.json .
```

Edit the generated config, then:

```bash
phase run ../my-task.phase.json
```

Phase prints the result and report paths:

```text
01 INSPECT
02 DELEGATE
03 VALIDATE
04 REVIEW
05 CONSOLIDATE
06 FINISH

PASS
result: .phase/runs/fix-example/result.json
report: .phase/runs/fix-example/report.html
```

Browse every run:

```bash
phase ui .phase/runs
# http://127.0.0.1:4317
```

Build a training corpus:

```bash
phase dataset .phase/runs ./phase-dataset

# Safer shareable corpus: task text is hashed/redacted.
phase dataset .phase/runs ./phase-dataset-portable --portable
```

---

## Harness config

The config is intentionally small. Keep it **outside the worker repository** so evaluator details are not visible to the coding agent.

```json
{
  "id": "auth-refresh-017",
  "cwd": "/home/me/project",
  "task": "Fix the refresh-token regression without changing normal login behavior.",

  "worker": {
    "adapter": "auto"
  },

  "verify": {
    "public": [
      "npm test",
      "npm run lint"
    ],
    "hidden": [
      "node tests/.phase-hidden-auth.js"
    ]
  },

  "hidden": {
    "install": [
      {
        "from": "/home/me/evaluators/auth-hidden.js",
        "to": "tests/.phase-hidden-auth.js"
      }
    ],
    "paths": [
      "tests/.phase-hidden-auth.js"
    ]
  },

  "isolation": {
    "enabled": true,
    "required": true,
    "read": []
  },

  "governor": {
    "policy": "heuristic",
    "max_repairs": 2
  },

  "training": {
    "enabled": true,
    "export_full_private_trace": false
  }
}
```

### Workers

Phase v0.7 uses a harness-agnostic adapter contract. See what is installed:

```bash
phase agents
```

The zero-config default is:

```json
{ "worker": { "adapter": "auto" } }
```

`auto` detects known non-interactive CLIs in this order: Pi, Codex, Claude Code, Gemini CLI, OpenCode, then Aider. Set `PHASE_AGENT=<id>` to pin the choice.

Built-in IDs are:

```text
pi  codex  claude  gemini  opencode  aider  exec  shell
```

You can select one directly:

```json
{ "worker": { "adapter": "claude" } }
```

Phase passes prompts by stdin or as a real argv value according to the adapter profile. Known agent auth/config paths (for example `~/.pi/agent`, `~/.codex`, `~/.claude`, or `~/.gemini`) are automatically added as narrow ephemeral writable sandbox copies when they exist. They still pass through the hidden-asset exposure check.

### Any current or future agent harness

If the harness has a non-interactive executable, Phase does not need native source support. Prefer the generic argv adapter:

```json
{
  "worker": {
    "adapter": "exec",
    "argv": ["my-agent", "run", "--headless"],
    "prompt": "stdin",
    "config_copy": ["~/.config/my-agent"],
    "runtime_read": []
  }
}
```

For agents that take the prompt as an argument:

```json
{
  "worker": {
    "adapter": "exec",
    "argv": ["my-agent", "run", "--prompt", "{prompt}"],
    "prompt": "argv"
  }
}
```

`argv` mode is preferred because Phase passes the prompt as one process argument rather than evaluating prompt text as shell syntax.

For reusable third-party support, put the contract in a JSON manifest:

```json
{
  "worker": {
    "manifest": "./my-agent.phase.json",
    "model": "optional-model-id"
  }
}
```

Example manifest:

```json
{
  "id": "my-agent",
  "label": "My Agent Harness",
  "detect": ["my-agent"],
  "invocation": {
    "argv": ["my-agent", "run", "--headless", "{prompt}"],
    "prompt": "argv"
  },
  "model_args": ["--model", "{model}"],
  "config_copy": ["~/.config/my-agent"],
  "runtime_read": []
}
```

That is the full integration boundary: launch non-interactively, accept a task over stdin or argv, and edit `cwd`. Phase continues to own isolation, provenance, validation, hidden evaluation, reports, and training export.

Legacy shell commands remain supported:

```json
{
  "worker": {
    "adapter": "shell",
    "command": "my-agent --non-interactive"
  }
}
```

The shell adapter defaults to prompt-on-stdin.

---

## The hidden-evaluator firewall

Phase's evaluator is visible to **you**, but remains hidden from the **agent**.

Run ordering is enforced:

```text
1. verify hidden install targets do not exist
2. start controller + coding worker
3. public validation
4. terminate agent/controller
5. provenance contamination audit
6. freeze brain.sqlite + phase index
7. materialize hidden evaluator assets
8. run hidden checks
9. verify memory artifacts are byte-identical
10. remove hidden assets
11. generate visual report + training data
```

This is stronger than “the prompt says not to look at the tests.” Hidden evaluator files do not exist in the workspace while the worker is alive, and v0.6+ also places the worker behind an OS filesystem boundary.

For hidden-evaluator runs on Linux, Phase creates a user + mount namespace, builds a temporary chroot containing only the repository plus read-only runtime/tool paths, leaves host `/proc` out of the sandbox, and drops all capabilities before executing the worker. The operator config, hidden evaluator sources, and other protected paths are absent from the worker filesystem. If Phase cannot establish that boundary, a required hidden run fails closed rather than falling back to an unrestricted shell.

Known agent credential/config paths are copied into the sandbox as ephemeral writable state so token refreshes and session writes do not touch the host. If a worker needs extra executable/runtime files, add them under `isolation.read`; if it needs writable host-derived state, add a narrow path under `isolation.copy`. The original `HOME` path is preserved inside the sandbox but starts empty except for explicitly exposed/copied subpaths. Phase rejects any read/copy allowlist that would also expose a protected evaluator asset.

The report makes the boundary explicit and records:

- public vs hidden checks,
- whether hidden assets were delayed,
- whether the provenance audit passed,
- whether the brain remained byte-identical during hidden evaluation,
- which behavior step triggered repair/retry.

---

## Provenance domains

Every session, observation, and memory claim is assigned a repository domain derived from the canonical Git repository root (or canonical working directory when no Git root exists). Evidence cannot cross that boundary.

Phase enforces this twice:

- `BrainStore` rejects cross-domain observations and claim evidence before writing them.
- SQLite triggers reject cross-repository `claim_evidence` links even if application code is bypassed.

Ledger verification also scans for cross-domain evidence links, and retrieval scopes memories by repository domain rather than only comparing raw working-directory strings.

---

## Visual run graph

Each `phase run` creates a standalone `report.html` with:

- behavior timeline,
- cloud call count,
- repair count,
- public/hidden verification scorecards,
- interactive step details,
- evaluator firewall visualization,
- expandable validation output,
- provenance/training metadata.

`phase ui` gives you a dashboard across all runs.

No external frontend dependencies are required; reports are self-contained HTML.

---

## Training data

A run is natively represented as:

```text
State_t → Behavior_t → Outcome_t → Verification
```

A validated coding-agent trace such as:

```text
read → grep → read → edit → pytest → git diff
```

is collapsed into:

```text
INSPECT → DELEGATE → VALIDATE → REVIEW → CONSOLIDATE → FINISH
```

The default training target contains **no patch generation target** and **no hidden-test body**.

Per run:

```text
.phase/runs/<id>/training/
├── accepted.repo-behavior.jsonl
├── accepted.repo-behavior-chat.jsonl
├── rejected.repo-behavior.jsonl
├── outcome.jsonl
├── behavior-manifest.json
└── export-manifest.json
```

Corpus aggregation:

```bash
phase dataset .phase/runs ./dataset
```

produces:

```text
dataset/
├── phase.repo-behavior.jsonl
├── phase.outcomes.jsonl
└── manifest.json
```

`--portable` replaces task text with a stable hash/redacted placeholder. It is meant for sharing aggregate agent-behavior data without shipping repository/task payloads.

### Rich private traces

Full observations, tool calls, and worker details can be useful for training larger coding models. Phase does not export these by default.

Explicit opt-in:

```bash
phase export .phase/runs/<id>/result.json --private
```

This writes `PRIVATE.full-trace.jsonl` locally. Treat it as source-code-sensitive data.

---

## Provenance and Phase memory

The v0.1–v0.4 provenance system remains the trust substrate:

```text
O... immutable observations
T... action receipts
M... grounded memories
```

Every memory must cite real evidence. The ledger is hash chained. Audits recompute stored evidence hashes and detect row tampering.

The phase-native associative index remains a **derived retrieval accelerator**. It may only return auditable `M...` IDs, which SQLite resolves and repository-scopes before a model sees them.

---

## Local governor

Today the default governor is deterministic, which makes the harness useful before any model training:

```text
inspect → delegate → validate → repair/retry → review → consolidate → finish
```

Set:

```bash
PHASE_CONTROLLER_POLICY=model
PHASE_CONTROLLER_URL=http://127.0.0.1:8080/v1
PHASE_CONTROLLER_MODEL=phase-repo-governor
```

to run a distilled local behavior model.

Training script:

```bash
python training/train_repo_governor.py \
  dataset/accepted.repo-behavior-chat.jsonl \
  --output phase-repo-governor
```

The SLM learns repository behavior, not code synthesis. Cloud coding models remain interchangeable workers.

---

## Commands

```text
phase init <config.json> [repo]
phase agents
phase run <config.json>
phase report <result.json> [out.html]
phase export <result.json> [--private]
phase ui [runs-dir] [--port 4317]
phase dataset <runs-dir> <out-dir> [--portable]
```

Legacy research/SLM scripts remain for reproducibility. v0.7's supported product surface is the `phase` CLI, the universal worker-adapter layer, and the optional Pi extension.

---

## Current validation

v0.7 passes **29/29 source tests**, including:

- OS-isolated hidden evaluator execution,
- delayed hidden asset materialization and memory/index freeze,
- cross-repository provenance-domain rejection,
- generic stdin and argv agent adapters,
- shell-injection-resistant argv prompt transport,
- external JSON adapter manifests,
- built-in adapter discovery,
- writable ephemeral auth/config copies that leave host credentials unchanged,
- automatic visual report and behavior-only training export,
- cloud-worker repair/retry,
- repository-scoped memory retrieval,
- action/observation tamper detection,
- provenance-backed memory.

Run:

```bash
npm test
```

---

## Product thesis

**Phase is the harness layer above coding agents.**

It does not need to beat Pi, Codex, Claude Code, or future coding models. It makes them easier to run, evaluate, compare, supervise, and learn from.

> **Every run becomes training data. Every failure becomes a lesson.**
