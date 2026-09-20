# Phase beta

**Run anything. Know exactly what happened.**

Phase is an event-sourced process runtime for AI agents, coding tools, services, CI jobs, and ordinary Unix commands. It wraps a real process, preserves its stdout/stderr byte-for-byte, measures the process group, records a hash-chained event log, and gives humans or agents simple process control.

There is no required dashboard and no proprietary workflow shell. Your program still behaves like your program.

```bash
phase run -- npm test
```

That is the main interface.

## Why

Agentic coding is usually constrained by context, retries, and recoverability rather than raw model intelligence. Phase makes the execution itself observable and controllable without forcing the agent into a custom harness.

```text
                ordinary process
          codex / claude / node / bash
                       │
                       ▼
                 ┌───────────┐
                 │   Phase   │
                 └─────┬─────┘
                       │
          append-only measured events
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
        human          SLM       infrastructure
        CLI            TPM       logs / OTEL
```

The log is the interface. Everything else is a view.

## Install

Requires Node.js 22.19+.

```bash
npm install
npm link
phase --help
```

## Five commands to learn

### Run

```bash
phase run -- npm test
phase run -- codex exec "fix the failing tests"
phase run -- python worker.py
```

The child keeps normal stdout and stderr behavior while Phase records exact copies.

Run a long-lived service in the background:

```bash
phase run -d --name api -- node server.js
```

### Watch

```bash
phase logs -f
```

Example:

```text
20:18:04 RUN    api → node server.js
20:18:04 PROC   pid=18291 pgid=18291
20:18:05 OUT    listening on :8080
20:18:09 EVENT  suite=auth passed=41 failed=1
20:18:10 CTRL   pause (SIGSTOP)
20:18:14 CTRL   resume (SIGCONT)
20:18:29 EXIT   code=0 signal=—
```

Useful filters:

```bash
phase logs --stream stderr
phase logs --type emit
phase logs --all                 # include resource samples
phase logs --json               # exact canonical event records
phase logs --json --with-output # integration-friendly message view
```

### Inspect

```bash
phase inspect
```

```text
● run_...  api
  state     running
  process   pid=18291  pgid=18291
  command   node server.js
  resources rss=184MB  cpu=1912ms  io=4.2MB↓/812KB↑  procs=3
  data      231 events  42KB stdout  1.1KB stderr
  integrity LIVE / UNSEALED
```

### Control

```bash
phase pause
phase resume
phase stop
phase kill
```

On Unix, Phase controls the entire process group, not only the first PID.

### Verify

When the process exits Phase seals the run:

```bash
phase verify
```

The verifier checks the event hash chain plus SHA-256 hashes and byte sizes of every canonical file.

## Agents can speak Phase without an SDK

Every wrapped process receives:

```text
PHASE_RUN_ID
PHASE_RUN_DIR
PHASE_SOCKET
PHASE_HOME
```

Any subprocess can publish a genuine structured signal with one shell command:

```bash
phase emit checkpoint tests=42 passed=41
phase emit context_miss subsystem=auth requested_tokens=4096
phase emit artifact path=dist/app.js bytes=184221
```

That event enters the same ordered hash chain as OS measurements and process output.

This makes Phase useful inside any existing agent workflow without requiring an agent framework integration.

## Storage

By default Phase writes to `.phase/runs/`. Set `PHASE_HOME` for servers:

```bash
export PHASE_HOME=/var/lib/phase
```

A sealed process run contains:

```text
command.json             immutable launch specification
events.ndjson            ordered SHA-256 hash-chained measurements
stdout.raw               byte-exact child stdout
stderr.raw               byte-exact child stderr
process-manifest.json    hashes, sizes, host metadata and Git state
SEALED                    manifest digest
meta.json                 mutable operational view (not canonical)
```

**Canonical data records what happened.** Derived summaries, rewards, dashboards, explanations, and training targets are never allowed to rewrite it.

Missing telemetry stays missing. Phase does not turn unknown measurements into convenient zeroes.

## Build a clean playtest corpus

Once runs have finished:

```bash
phase corpus
phase verify .phase/corpus
```

Only sealed, verified process runs enter the index. Live runs are reported as skipped and corrupt sealed runs fail the build. The corpus points back to the original content-addressed run data rather than creating a cleaned substitute.

## Existing infrastructure

Phase intentionally composes with normal operations tooling.

```bash
# shell pipelines
phase logs --json --with-output -f | vector ...

# RFC 5424-ish syslog view
phase export --format syslog

# OpenTelemetry LogRecord JSON view
phase export --format otel

# plain JSONL
phase export --format jsonl
```

See [docs/integrations.md](docs/integrations.md) for systemd, Docker, Kubernetes, Vector/Fluent Bit, and OpenTelemetry patterns.

## Vibe coding for agents

An agent does not need to preserve a giant conversation to remain useful. Run it as a process, let it emit important state transitions, and let Phase preserve the execution boundary:

```bash
phase run -d --name repair-auth -- \
  codex exec "repair auth, run tests, stop when the suite passes"

phase logs -f
```

A second agent, an SLM scheduler, or a human can inspect the same event stream. No agent needs another agent's private chain of thought.

## Research layer

Phase 1.0's allocator/ISA research remains underneath the process runtime. Advanced commands are still available:

```bash
phase init
phase compile "..."
phase run phase-workflow.json
phase trace <research-run>
phase raw <research-run>
phase corpus
phase train
```

The long-term TPM dataset is simply a cleaner form of the same idea:

```text
preceding measured events
          ↓
allocation / control decision
          ↓
following measured events
          ↓
objective outcome
```

Project facts belong in the project. The small model learns allocation behavior, not doctrine.

## Beta principle

Phase should be less complicated than the thing it observes.

If a command works outside Phase, this should usually work:

```bash
phase run -- <that command>
```
