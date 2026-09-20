# Process runtime

Phase treats the operating-system process as the universal adapter.

## Lifecycle

`phase run` creates a run directory and starts a supervisor. The supervisor starts the workload in its own process group on Unix, captures stdout/stderr, samples OS resource counters, exposes a run-local control socket, and seals the run after exit.

Foreground mode tees child stdout/stderr back to their original terminal streams. Phase status messages go to stderr. This keeps ordinary pipelines usable.

Background mode (`-d`) detaches the supervisor. `phase logs -f`, `phase inspect`, and the control commands communicate through files and the run-local socket.

## Event ordering

Only the supervisor appends canonical events. External commands such as `phase emit`, `pause`, and `stop` send requests over the control socket. This preserves a single sequence and a single SHA-256 hash chain.

## Resource telemetry

On Linux, Phase samples every process in the child process group through `/proc` and records:

- process count
- user/system/total CPU time
- aggregate resident memory
- observed read bytes
- observed write bytes

The default interval is 1000ms and can be changed with `--sample-ms`.

Unsupported measurements are `null`, not zero.

## Process control

On Unix:

- `pause` → `SIGSTOP`
- `resume` → `SIGCONT`
- `stop` → `SIGTERM`
- `kill` → `SIGKILL`

Signals target the process group so agent-spawned subprocesses are controlled together.

## Canonical vs derived

Canonical:

- `command.json`
- `events.ndjson`
- `stdout.raw`
- `stderr.raw`

Derived/operational:

- `meta.json`
- terminal rendering
- JSON-with-message exports
- syslog/OTel views
- future dashboards and SLM training views

This boundary is intentional: a view may be regenerated without changing the underlying experiment.
