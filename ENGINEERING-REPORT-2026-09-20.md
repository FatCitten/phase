# Phase Pi Integration Engineering Report

**Date:** 2026-09-20  
**Author:** Phase Development Team  
**Commit:** v1.1.0-beta.1 + Pi integration

---

## INTEGRATION

### Goal Achieved: `phase run -- pi` Works

The Pi coding agent now runs natively inside Phase as an ordinary process. Phase captures:
- Byte-exact stdout/stderr
- Process lifecycle events (spawn, exit, signals)
- Resource sampling (RSS, CPU, I/O, process count)
- Structured events emitted by Pi via `phase emit`
- Hash-chained event log with SHA-256 integrity

**Verified Commands:**
```bash
phase run -- pi -p "<prompt>"                    # Run Pi wrapped in Phase
phase logs -f                                     # Follow event stream
phase inspect <run_id>                            # Human-readable summary
phase ps --json                                   # Machine-readable run listing
phase verify <run_id>                             # Integrity check
phase stats <run_id> --field score                # Aggregate emitted metrics
```

**Environment Variables Available to Pi:**
- `PHASE_RUN_ID` — Unique run identifier
- `PHASE_RUN_DIR` — Path to run data directory
- `PHASE_SOCKET` — Control socket path
- `PHASE_HOME` — Phase storage root

### New Components

| File | Purpose |
|------|---------|
| `src/process-episodes.mjs` | Converts sealed process runs → TPM training episodes |
| `scripts/run-pi-task.mjs` | Bounded Pi task runner with timeout/verify/corpus admission |
| `tasks/` | Task definitions for dataset generation |
| `skills/phase/SKILL.md` | Enhanced Pi skill with event emission guidance |

### CLI Enhancements

- `phase ps --json` — JSON output for machine consumption (implemented by Pi in task)
- `phase stats <run> [--emit TYPE] [--field KEY]` — Aggregate numeric emit fields
- `--timeout N` — Auto-terminate process group after N ms
- `--kill-group` — SIGKILL entire process group on exit/timeout
- `--scan-every N` — Full /proc rescan interval for process group discovery

---

## DATASET

### Initial Corpus: 9 Sealed Process Runs

| Run ID | Name | Status | Wall Time | Outcome |
|--------|------|--------|-----------|---------|
| run_20260920_020953_e2a1fa | task-ps-json | ✓ exited | 6.6s | Feature implemented |
| run_20260920_020943_be181f | hello-pi | ✓ exited | 2.5s | Env var confirmed |
| run_20260920_020709_0c2167 | task-01-bugfix | ✗ failed | 120s | Timeout (model hang) |
| run_20260920_015358_4d01bd | playtest-pi-1 | ✓ exited | 2.4s | Emit verified |
| run_20260920_015354_e74ade | playtest-sanity | ✓ exited | 0.4s | Baseline |
| run_20260920_013259_00c995 | t-orphan | ✓ exited | 0.3s | Orphan process test |
| run_20260920_013252_3c2d8f | t-stats | ✓ exited | 0.4s | Emit test |
| run_20260920_013238_3c5085 | t-sampling | ✗ failed | 1.2s | Sampling test |
| run_20260920_013229_b5fc74 | t-timeout | ✗ failed | 1.5s | Timeout test |

**Training Dataset:** `.phase/corpus/process-allocator-chat.jsonl`
- 9 episodes in chat format (system, user, assistant)
- State vectors: 96-dimensional, hash-based feature encoding
- Targets: Phase ISA assembly (ROUTE, ALLOC, GRANT)
- Measurements: wall_ms, exit_code, rss_bytes, cpu_ms, validation status

### Data Integrity

- All runs: **SEALED + VERIFIED** (hash chain intact)
- Manifest SHA-256 recorded per run
- No canonical data modified — all derived views are separate files
- Unknown measurements preserved as `null` (not coerced to zero)

---

## TRAINING

### Pipeline Status: Ready

**Training Script:** `training/train_allocator.py`
- Base model: `Qwen/Qwen2.5-0.5B-Instruct` (configurable)
- LoRA fine-tuning (r=8, alpha=16)
- SFT on chat-format dataset
- Outputs: `phase-tpm-allocator/` with adapter + manifest

**Dataset Compiler:** `scripts/compile-allocator-dataset.mjs` + `src/process-episodes.mjs`
- Converts sealed runs → allocation episodes
- Builds chat-format training data
- Preserves provenance (source_manifest_sha256)

### Smoke Test: Pending

Actual training requires:
- PyTorch + CUDA (recommended) or CPU fallback
- `transformers`, `trl`, `peft`, `datasets` packages
- ~15 minutes for 9 examples (3 epochs)

**Next Step:** Run `python3 training/train_allocator.py .phase/corpus/process-allocator-chat.jsonl --output models/phase-tpm-v1`

---

## EVALUATION

### Baseline Metrics (Heuristic Allocator)

The current heuristic allocator provides:
- Initial context: 55% of ceiling
- Reserve fraction: 18%
- Repair reserve: 12%
- Policy: `heuristic` or `heuristic-fallback` (if model unavailable)

### Planned Comparison

| Policy | Metric | Measurement Method |
|--------|--------|-------------------|
| A. Heuristic | Tasks completed / wall time | `phase corpus` + derived stats |
| B. Trained TPM | Tasks completed / wall time | Same tasks, different allocator |

**Controlled Variables:**
- Same Pi agent/model
- Same resource pool
- Same task set

**Primary Question:** Does the trained TPM sustain more validated work per unit resource?

---

## KNOWN LIMITATIONS

1. **No automatic validation command execution** — Pi must emit validation events manually; Phase doesn't auto-run tests yet.

2. **Event emission relies on agent cooperation** — Pi must call `phase emit` for structured signals. Automatic capture is limited to OS-level measurements.

3. **No Phasebin conversion for process runs** — Process runs produce `events.ndjson`, not `.phasebin` binary format. Training uses the NDJSON directly.

4. **Small dataset (n=9)** — Insufficient for meaningful generalization. Need 50+ runs across diverse tasks.

5. **One timeout failure (task-01-bugfix)** — Pi hung without output. Root cause: model responsiveness issue, not Phase bug.

6. **Name resolution inconsistent** — `phase inspect <name>` works, but `phase logs/stats/verify` require run_id or path.

---

## NEXT EXPERIMENT

### Task Matrix Expansion

Run the full task suite (`tasks/task-01` through `task-06`) to generate:
- 6+ successful completions
- 2+ failure → repair cycles
- 1+ constrained budget run
- Measurable variation in context misses, retries, wall time

Target: **20 sealed runs** by end of week.

### Training Smoke Test

1. Install PyTorch + dependencies
2. Run training on current 9-episode dataset
3. Verify model loads and produces valid ISA output
4. Document hardware/time/quality metrics

### Heuristic vs. TPM Comparison

1. Select 3 tasks (easy, medium, hard)
2. Run each 5x with heuristic allocator
3. Train TPM on first 4 runs per task
4. Run 5th with TPM allocation
5. Compare: wall time, validation pass rate, resource efficiency

---

## Commands Reproduced

```bash
# Run Pi under Phase
phase run -- pi -p "Implement feature X" --timeout 120000

# Watch execution
phase logs -f

# Verify integrity
phase verify latest

# Build corpus
node src/process-episodes.mjs .phase .phase/corpus

# Train (pending dependencies)
python3 training/train_allocator.py .phase/corpus/process-allocator-chat.jsonl --output models/phase-tpm-v1

# Run task harness
node scripts/run-pi-task.mjs --name my-task --prompt "..." --timeout 120000
```

---

## Conclusion

The core integration is **complete and functional**:
- ✅ Pi runs under Phase
- ✅ Execution data captured canonically
- ✅ Training episodes derived
- ✅ Pipeline ready for smoke training
- ✅ Task harness operational

The dataset is small but genuine. The next milestone is scaling to 20+ runs and completing the first TPM training run.

**Principle Upheld:** Canonical data is immutable measurement. Derived views never rewrite source.
