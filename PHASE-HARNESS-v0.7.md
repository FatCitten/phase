# Phase Harness v0.7 — Universal Agent Adapters

v0.7 makes the coding worker a replaceable execution adapter rather than a Pi/Codex-specific command string.

## Contract

Phase only requires an agent harness to satisfy three conditions:

1. it can be launched non-interactively,
2. it receives a task by stdin or one argv value, and
3. it edits the repository represented by its current working directory.

Everything else stays owned by Phase: OS isolation, hidden evaluation, provenance, repository-domain enforcement, validation, reports, and training export.

## Built-ins

`auto`, `pi`, `codex`, `claude`, `gemini`, `opencode`, `aider`, `exec`, and `shell`.

`phase agents` reports which known CLIs are installed. `worker.adapter: "auto"` selects the first detected built-in profile. `PHASE_AGENT=<id>` pins auto-selection.

## Unknown/future harnesses

Use an argv adapter directly:

```json
{
  "worker": {
    "adapter": "exec",
    "argv": ["my-agent", "run", "--headless"],
    "prompt": "stdin",
    "config_copy": ["~/.config/my-agent"]
  }
}
```

Or point Phase at a JSON manifest:

```json
{
  "worker": {
    "manifest": "./my-agent.phase.json"
  }
}
```

A manifest can declare `argv` or `command`, prompt transport, model flags, environment variables, and narrowly scoped config/runtime read paths needed inside Phase's sandbox.

## Security property

Prompts passed through `argv` are spawned as real argument vectors outside isolation and shell-quoted only when converted into the isolated chroot command. Custom shell adapters remain available for compatibility, but argv adapters are preferred because prompt text is not interpreted as shell syntax.

Known agent credentials/config directories are copied into the sandbox as ephemeral writable state and only when they exist. Hidden evaluator/config paths remain protected by the v0.6 isolation planner; a requested read/copy path that would reveal an evaluator asset is rejected before the worker starts.
