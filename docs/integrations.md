# Integrations

Phase is designed to look like a normal Unix process wrapper and log source.

## systemd

```ini
[Unit]
Description=Phase-managed agent service
After=network-online.target

[Service]
Type=simple
User=phase
WorkingDirectory=/srv/app
Environment=PHASE_HOME=/var/lib/phase
ExecStart=/usr/bin/phase run -- node server.js
Restart=on-failure
KillMode=control-group

[Install]
WantedBy=multi-user.target
```

Normal service logs still reach journald because foreground Phase preserves child stdout/stderr.

```bash
journalctl -u phase-agent -f
```

Phase's research record remains independently available under `/var/lib/phase/runs`.

## Docker

```dockerfile
ENTRYPOINT ["phase", "run", "--"]
CMD ["node", "server.js"]
```

Mount a persistent Phase data directory:

```bash
docker run \
  -e PHASE_HOME=/phase \
  -v phase-data:/phase \
  my-image
```

Container stdout/stderr behavior is unchanged.

## Kubernetes

Use Phase as the container command or entrypoint and persist `/phase` if the research record must survive pod deletion.

```yaml
containers:
  - name: worker
    image: example/agent:latest
    command: ["phase", "run", "--"]
    args: ["node", "server.js"]
    env:
      - name: PHASE_HOME
        value: /phase
    volumeMounts:
      - name: phase-data
        mountPath: /phase
```

Phase does not require a sidecar. A log-export sidecar may be added if desired.

## Vector / Fluent Bit / Logstash

Use the derived JSON message stream:

```bash
phase logs <run> --json --with-output -f
```

or:

```bash
phase export <run> --format jsonl -f
```

Canonical files remain untouched.

## Syslog

```bash
phase export <run> --format syslog -f | logger
```

## OpenTelemetry

Phase can render each event as an OpenTelemetry LogRecord-shaped JSON object:

```bash
phase export <run> --format otel -f
```

This is intentionally a JSON view rather than a built-in collector client. Pipe it through the collector/forwarder already deployed in the environment. Phase should not become another telemetry backend.

## Agent frameworks

No adapter is required for basic operation:

```bash
phase run -- codex exec "..."
phase run -- claude -p "..."
phase run -- aider ...
phase run -- python custom_agent.py
```

Inside the workload, use `phase emit` for milestones that are meaningful to the project. The command communicates through `PHASE_SOCKET`, inherited automatically by descendants.
