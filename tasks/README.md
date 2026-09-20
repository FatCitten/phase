# Pi Task Definitions

This directory contains bounded coding tasks for generating the initial Phase TPM training dataset.

Each task is designed to produce genuine, measurable signals:
- Varying complexity (small bugfix → multi-file refactor)
- Different validation outcomes (pass/fail/repair cycles)
- Measurable context misses
- Observable resource consumption

## Task Matrix

| ID | Type | Expected Wall Time | Complexity | Validation |
|----|------|-------------------|------------|------------|
| task-01 | Bug fix (single file) | 30-60s | Low | Unit tests pass |
| task-02 | TDD implementation | 60-120s | Medium | New tests + impl |
| task-03 | Refactor (multi-file) | 90-180s | Medium-High | Tests pass post-refactor |
| task-04 | Exploration + fix | 60-120s | Medium | Tests pass |
| task-05 | Intentional failure + repair | 120-180s | Medium | Initial fail → repair → pass |
| task-06 | Constrained budget | 60-90s | Medium | Pass within tight limits |

## Running Tasks

```bash
# Run a single task
node scripts/run-pi-task.mjs --name task-01-bugfix --prompt "$(cat tasks/task-01-bugfix.txt)" --timeout 120000

# Run the full matrix (sequential)
for f in tasks/task-*.txt; do
  name=$(basename "$f" .txt)
  prompt=$(cat "$f")
  node scripts/run-pi-task.mjs --name "$name" --prompt "$prompt" --timeout 180000
done

# Build corpus from all sealed runs
node scripts/phase.mjs corpus

# Verify corpus integrity
phase verify .phase/corpus

# Build training dataset
node src/process-episodes.mjs .phase .phase/corpus

# Smoke-train the allocator (requires PyTorch + GPU recommended)
python3 training/train_allocator.py .phase/corpus/process-allocator-chat.jsonl --output models/phase-tpm-v1
```

## Task Design Principles

1. **Measurable outcome**: Each task has a clear pass/fail criterion (tests, validation command).
2. **Bounded scope**: Tasks complete in <5 minutes to enable rapid iteration.
3. **Genuine difficulty**: Tasks require actual reasoning, not trivial copy-paste.
4. **Observable signals**: Tasks should produce context misses, retries, or artifacts that Phase can measure.
5. **No chain-of-thought leakage**: Pi emits sparse milestones, not internal reasoning.

## Adding a Task

Create `task-NN-description.txt` with:
```
<One-paragraph task description>

Success criteria:
- <criterion 1>
- <criterion 2>

Constraints:
- <constraint 1>
- <constraint 2>
```

Then run it via `run-pi-task.mjs`.
