# Phase Forge — from audited experience to a local SLM agent

Phase Forge combines the Phase second brain and the phase-native associative memory in a different way:

```text
large teacher agent
      ↓
audited tool trajectories
      ↓
hidden-test validator
      ↓
accepted experience only
      ↓
Phase Forge compiler
      ↓
small policy model (SLM)
      ↓
CPU / phone / laptop agent
      ↕
Phase external brain
```

The key idea is **episodic-to-parametric consolidation**.

- New, rare, repository-specific facts stay in the Phase brain.
- Repeated successful *procedures* become supervised training examples.
- A small model learns the procedure: what to inspect, which tool to call, what edit to make, when to test, and when to stop.
- Phase remains the external long-term memory, so the model does not need to memorize the repository.
- Every training example points back to an auditable session and validator result.

This is closer to hippocampus/cortex consolidation than ordinary RAG: the external memory keeps episodes and facts; stable behavior is gradually transferred into weights.

## Why this can make a tiny model useful

A general coding agent must simultaneously:

1. understand arbitrary language;
2. remember repository structure;
3. decide what to inspect;
4. reason about tool use;
5. generate code;
6. manage long context;
7. detect completion;
8. recover from mistakes.

Phase Forge externalizes several of those burdens.

The student model is trained as a **next-action policy**, not a chatbot. One inference produces one action:

```json
{"tool":"read","args":{"path":"src/auth.ts","offset":1,"limit":200}}
```

The deterministic runtime handles execution, persistence, provenance, memory retrieval, and validation. This means a sub-1B model can spend its capacity on the narrow part that actually needs learned judgment.

## The two memories

```text
PARAMETRIC MEMORY (SLM weights)
  reusable procedures
  coding syntax
  tool-selection habits
  task decomposition patterns

EPISODIC / SEMANTIC MEMORY (Phase)
  repository facts
  historical findings
  architecture decisions
  file-linked evidence
  stale/fresh provenance
```

The student receives a compact set of audited Phase memories at every step. The phase-native fixed vector accelerates candidate recall, but SQLite remains canonical truth.

## Teacher mode

Run normal Pi + Phase on real tasks. Phase v0.3 records:

- user prompt receipt;
- every tool call and arguments;
- every tool result;
- file/Git evidence;
- memory reads/writes;
- tamper-evident action provenance;
- session ledger head.

Then the hidden-test harness independently decides whether the trajectory succeeded.

Only successful trajectories become positive SFT data.

Failed runs are kept separately for future preference learning / hard-negative mining.

## Compile validated experience

Run a teacher suite:

```bash
node scripts/suite.mjs /outside/worktree/teacher-suite.json
```

Or run the whole collection + compilation step:

```bash
node scripts/forge-cycle.mjs /outside/worktree/teacher-suite.json
```

The compiler emits:

```text
accepted.phase-action.jsonl     canonical generic action data
rejected.phase-action.jsonl     failed trajectories, never mixed into positive SFT
accepted.json-action.jsonl      generic one-action JSON chat training set
accepted.functiongemma.jsonl    FunctionGemma messages + tool calls
manifest.json                   hashes + source sessions + ledger heads
```

Every positive example is traceable to a validator-approved session.

## Initial student tracks

### Track A — Phase Coder 0.5B

Default research target:

```text
Qwen2.5-Coder-0.5B-Instruct
        +
Phase JSON-action fine-tune
        +
Q4_K_M GGUF
```

This model is code-specialized and has small GGUF variants suitable for CPU inference. The student uses the `json-action` protocol, so it does not require native function-call parsing from the base model.

Train:

```bash
python -m venv .venv-train
source .venv-train/bin/activate
pip install -r training/requirements.txt

python training/train_action_model.py \
  .phase/forge/accepted.json-action.jsonl \
  --output phase-student-qwen05b
```

If LoRA was used, merge:

```bash
python training/merge_lora.py phase-student-qwen05b \
  --base-model Qwen/Qwen2.5-Coder-0.5B-Instruct \
  --output phase-student-merged
```

Convert + quantize with llama.cpp:

```bash
scripts/export-gguf.sh phase-student-merged /path/to/llama.cpp phase-student
```

### Track B — Phase Nano 270M

FunctionGemma is specifically designed to be fine-tuned for constrained function-calling workflows.

```bash
python training/train_functiongemma.py \
  .phase/forge/accepted.functiongemma.jsonl \
  --output phase-student-functiongemma-270m
```

This is the ultra-small track. It may be excellent at repository-specific tool policy but too weak for broad code synthesis; Phase must measure that rather than assume it.

## Run without Pi

Start a local llama.cpp server with your student GGUF, then:

```bash
PHASE_STUDENT_URL=http://127.0.0.1:8080/v1 \
PHASE_STUDENT_MODEL=phase-student \
node scripts/student.mjs \
  --cwd /path/to/repo \
  --task "Fix the stamina bug and run the tests"
```

The student runtime provides:

- `read`
- `list`
- `search`
- `edit`
- `write`
- `bash`
- `phase_recall`
- `phase_remember`
- `finish`

It records the same provenance structure as the teacher extension.

For FunctionGemma/native function-call output, use:

```bash
PHASE_STUDENT_PROTOCOL=tool-call node scripts/student.mjs ...
```

For the generic distilled coding model:

```bash
PHASE_STUDENT_PROTOCOL=json-action node scripts/student.mjs ...
```

## The improvement loop

```text
1. teacher solves tasks
2. hidden validator filters trajectories
3. Forge emits accepted actions
4. train student
5. quantize to local GGUF
6. evaluate student on HELD-OUT tasks
7. collect student failures
8. teacher solves those failures
9. add corrected trajectories
10. retrain
```

This is not self-training on the student's own guesses. The trusted label is external task validation plus teacher correction.

## Evaluation gate

Do not compare on the training suite.

Use a separate held-out suite:

```bash
node scripts/student-suite.mjs /outside/worktree/base-eval-suite.json
node scripts/student-suite.mjs /outside/worktree/distilled-eval-suite.json

node scripts/compare-students.mjs \
  /path/to/base/suite-result.json \
  /path/to/distilled/suite-result.json
```

Primary metric:

```text
hidden-test task success
```

Secondary metrics:

```text
model calls
tool steps
prompt tokens
completion tokens
tool errors
wall time
model-call latency
peak RSS (future benchmark addition)
```

A training run counts as a win only if the distilled model improves held-out task success, or holds success constant while reducing work. Training loss is not an acceptance criterion.

## Research hypotheses

### H1 — externalized knowledge allows a smaller policy

For a fixed task distribution:

```text
student + Phase memory > same student without Phase
```

### H2 — validated distillation beats the untouched base SLM

```text
fine-tuned 0.5B + Phase > base 0.5B + Phase
```

on held-out repository tasks.

### H3 — longitudinal specialization reduces work

As validated experience grows:

```text
steps/task ↓
repository exploration ↓
model tokens/task ↓
task success ↔ or ↑
```

### H4 — knowledge can migrate from external memory into weights

Frequently reused, stable trajectories should eventually be solved with fewer explicit memory calls after fine-tuning.

This creates a measurable consolidation curve instead of a biological analogy.

## Important limits

- A 270M or 500M model will not become a frontier general-purpose coding model just because it has memory.
- Specialization gains are expected to be distribution-specific. Generalization must be tested on unseen tasks and changed files.
- CPU inference can be broadly deployable, but “any device” is too strong literally; RAM, ISA support, storage, and acceptable latency still matter.
- Training may still be much faster on a GPU. The product claim is local **inference**, not necessarily local full-parameter training.
- `bash` is powerful and is not an OS sandbox. Publication-grade hidden-test evaluation should isolate the student process from evaluator files with containers/bubblewrap.
- The phase-native index has bounded capacity and already self-degrades to canonical retrieval when its noise floor is too high.

## What would make this important

The interesting result is not merely “a 500M model runs on CPU.” That already exists.

The interesting result would be:

> A tiny local model, after learning from a repository's validated agent history and using an auditable external memory, beats its untouched base model on real held-out software tasks while using dramatically less compute than a cloud agent.

If Phase can demonstrate that reproducibly across repositories, the extension stops being a memory plugin and becomes a **compiler from expensive agent experience into cheap local intelligence**.
