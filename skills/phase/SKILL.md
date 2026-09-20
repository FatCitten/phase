# Phase Process Skill for Pi

You are executing inside a **Phase run**. Phase is recording your execution byte-for-byte: stdout, stderr, process lifecycle, and structured events you emit.

## Mental Model

```
You → Phase → Human/Researcher
     (records)
```

Phase is **not** reading your chain-of-thought. Phase records:
- What you **did** (stdout/stderr, tool calls, file changes)
- What you **declared** (emitted events)
- What **happened** (measurements: timing, memory, exit codes, validation results)

## Core Directive

**Work normally. Emit sparsely. Let Phase measure reality.**

Do not narrate for Phase. Do not explain your reasoning into the log. Phase already has your stdout.

Emit an event only when something **materially changes**:
- A milestone reached (checkpoint)
- A blocking problem discovered
- A validation result (pass/fail)
- An artifact created/modified
- A context miss (you needed information you didn't have)
- A human decision required
- A retry initiated

## When to Emit

| Situation | Emit | Example |
|-----------|------|---------|
| Starting a major phase | `checkpoint` | `phase emit checkpoint stage=research scope=auth_module` |
| Tests pass/fail | `validation` | `phase emit validation name=unit_tests status=pass count=41` |
| You hit a knowledge gap | `context_miss` | `phase emit context_miss topic=database_schema reason="no migrations found"` |
| Blocked by ambiguity | `blocker` | `phase emit blocker type=requirement_ambiguity files="[src/auth.ts]"` |
| Created/modified file | `artifact` | `phase emit artifact path=src/auth.ts action=modified lines=+42/-12` |
| Human made a decision | `decision` | `phase emit decision id=H17 source=human choice=use_jwt` |
| Retrying after failure | `retry` | `phase emit retry attempt=2 reason=test_failure` |

## When NOT to Emit

- Every tool call (Phase can observe these)
- Every file read (noise)
- Your internal reasoning (private, disposable)
- Confidence statements ("I'm confident this is correct")
- Prose summaries of what you just did (stdout already has it)

## Event Reference

```bash
# Milestone reached
phase emit checkpoint stage=<name> [key=value ...]

# Validation result
phase emit validation name=<test_suite> status=<pass|fail> [count=<N>] [duration_ms=<N>]

# Knowledge gap
phase emit context_miss topic=<subject> [reason="<brief>"] [requested_tokens=<N>]

# Blocking issue
phase emit blocker type=<category> [reason="<brief>"] [files="[...]"]

# File artifact
phase emit artifact path=<file> action=<created|modified|deleted> [bytes=<N>] [lines=<delta>]

# Human decision
phase emit decision id=<H17> source=<human|agent> [choice="<summary>"]

# Retry
phase emit retry attempt=<N> [reason="<brief>"]
```

## Rules

1. **Human intent dominates.** If the human gives a constraint, follow it even if your allocation suggests otherwise.

2. **Project facts from evidence.** Read the codebase. Do not assume. If you don't know, say so (context_miss), don't guess.

3. **Measurements over beliefs.** Emit numbers (test counts, timings, byte sizes) not confidence.

4. **Sparse, genuine signals.** 3-10 events per run is typical. 50+ events means you're narrating, not instrumenting.

5. **Stdout/stderr are already captured.** Do not duplicate them as events.

6. **Another agent should continue from logs + state.** If you vanish mid-task, a fresh agent reading Phase logs + project files should pick up exactly where you left off.

## Example Session

```bash
$ phase run -- pi -p "Implement auth middleware"

# Agent reads codebase
$ read src/app.ts
$ read package.json

# Agent emits first milestone
$ phase emit checkpoint stage=research scope=auth_module files_read=3

# Agent discovers missing DB schema
$ phase emit context_miss topic=database_schema reason="no migrations in repo"

# Agent asks human
[Human provides schema]
$ phase emit decision id=H1 source=human choice=use_postgres_users_table

# Agent implements
$ edit src/auth.ts
$ edit tests/auth.test.ts

# Agent runs tests
$ bash npm test
# Tests pass
$ phase emit validation name=auth_tests status=pass count=12

# Done
$ phase emit checkpoint stage=complete artifacts=2 tests_passed=12
```

## Training Implications

Your emitted events become **training signals** for the Phase TPM (Tiny Process Manager) SLM:

- `context_miss` → teaches when to allocate more context tokens
- `validation fail` → teaches when to allocate repair reserve
- `retry` → teaches task difficulty estimation
- `checkpoint` + timestamps → teaches progress rate estimation
- `artifact` → teaches output volume prediction

The TPM learns **allocation policy**, not project facts. Your events help it answer:
> "Given this state, how much context/time/tool budget should I allocate to complete this fiber?"

## Privacy

- Your private reasoning stays in your context window (disposable)
- Only emit concrete operational signals
- Never emit secrets, API keys, or sensitive data
- Phase logs are private by default (in `.phase/runs/`)

---

**Remember:** You are a coding agent. Code. Test. Fix. Ship. Let Phase record what happened. Emit when it matters.
