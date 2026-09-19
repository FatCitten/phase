# Phase Repo Governor v0.4

Phase no longer tries to replace the coding model.

It replaces the **agent loop around the coding model**.

## Split of responsibility

### Local Phase governor
Learns repository behavior only:

1. `inspect` — acquire the minimum repo state needed.
2. `delegate` — invoke a strong cloud coding worker.
3. `validate` — run deterministic public validation.
4. `repair` — re-delegate with concrete validator failure.
5. `review` — inspect diff/invariants before acceptance.
6. `consolidate` — write validator-backed repo knowledge to Phase memory.
7. `finish` — only after acceptance gates pass.

### Cloud coding worker
Still does the difficult generative work:

- code synthesis
- patch construction
- semantic refactors
- API/library knowledge
- debugging inside the delegated coding turn

The governor does **not** learn file contents, patches, code tokens, or exact edits as targets.

## Why this is a better distillation target

The old Phase Forge target was:

`repo state -> exact next coding tool call`

That eventually requires the student to learn code generation.

The new target is:

`repo execution state -> repo-management behavior`

The high-level action vocabulary is fixed and tiny. Repository knowledge remains in the audited Phase brain, and code-generation intelligence remains in the cloud worker.

## Distillation from normal cloud-agent traces

Phase already observes Pi tool calls. On validator-approved sessions the behavior compiler collapses low-level runs:

```
read -> grep -> read -> edit -> pytest -> git diff
```

into:

```
INSPECT -> DELEGATE -> VALIDATE -> REVIEW -> CONSOLIDATE -> FINISH
```

The training target contains **no patch**.

Failed hidden-test sessions are kept out of the positive dataset.

## Runtime

Set the coding worker command. It must accept the coding prompt on stdin and work in the current directory.

Examples:

```bash
export PHASE_CLOUD_COMMAND='pi -p --approve'
# or a wrapper around Codex / Claude Code / another cloud coding harness
```

Run:

```bash
node scripts/repo.mjs "fix the failing authentication test"
```

Inside Pi after installing the extension:

```text
/phase-run fix the failing authentication test
```

The cloud worker receives `PHASE_ROLE=worker`, `PHASE_CONTROLLER_ACTIVE=1`, and the governor brain via `PHASE_DB`, so an instrumented Pi worker can contribute its low-level trajectory to later behavioral distillation.

## Validation and hidden tests

For benchmark work, keep the task JSON outside the worktree and run:

```bash
node scripts/repo-hidden-test-harness.mjs /outside/task.json
```

Phase runs the repo governor first. Only afterward does the harness freeze the brain/index, inject hidden evaluator material, and validate. Only passing sessions should enter the behavior corpus.

## Compile behavior data

```bash
node scripts/compile-behavior-dataset.mjs suite-result.json forge-behavior
```

Outputs:

- `accepted.repo-behavior.jsonl`
- `accepted.repo-behavior-chat.jsonl`
- `rejected.repo-behavior.jsonl`
- `behavior-manifest.json`

The compiler supports both native `repo:*` controller traces and ordinary Pi/cloud-agent traces. Ordinary tool traces are collapsed into high-level behavior transitions.

## Train the local governor

The default training target is now a general small instruct model, not a code model:

```bash
python training/train_repo_governor.py \
  forge-behavior/accepted.repo-behavior-chat.jsonl \
  --base-model Qwen/Qwen2.5-0.5B-Instruct \
  --output phase-repo-governor
```

A 270M-class function/instruction model is also a natural experiment because the output vocabulary is only seven behaviors.

At runtime, point the governor at an OpenAI-compatible local endpoint:

```bash
export PHASE_CONTROLLER_POLICY=model
export PHASE_CONTROLLER_URL=http://127.0.0.1:8080/v1
export PHASE_CONTROLLER_MODEL=phase-repo-governor
```

The cloud coding worker remains unchanged.

## Acceptance criterion

The local governor is useful only if it preserves cloud-worker task success while reducing some combination of:

- cloud coding calls
- wasted repo exploration
- repeated failed edits
- validation retries
- cloud input tokens
- wall time / cost

A successful result is **not** “the governor predicts its labels.” It must improve end-to-end held-out repository work while hidden-test success stays flat or improves.
