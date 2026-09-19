# Phase Cloud v0.8

Phase Cloud is the premium network layer for Phase Harness. Local orchestration, provenance, isolation, validation, and reports remain usable without the cloud. Premium adds live run sync and the foundation for fleet analytics, hosted run history, team dashboards, benchmark intelligence, and managed policy distribution.

## Wire protocol

Phase connects over WebSocket using `phase-cloud-v1`:

1. client opens `ws://` or `wss://` connection,
2. client sends `hello` with its API key,
3. server returns `hello.ack` with premium entitlements,
4. client streams `event` envelopes,
5. server ACKs every event by ID.

The harness does not send run events until the server confirms the `premium` entitlement.

## Config

```json
{
  "cloud": {
    "enabled": true,
    "url": "wss://cloud.example.com/v1/runs",
    "api_key_env": "PHASE_CLOUD_API_KEY",
    "telemetry": "metrics",
    "data_product": "aggregate",
    "required": false
  }
}
```

`required=false` means a cloud outage does not prevent local coding work. Set it to `true` for centrally governed environments that require cloud receipt confirmation.

### Telemetry modes

- `off`: no private customer payloads are uploaded. An explicitly enabled aggregate product stream may still be sent.
- `metrics`: uploads operational run metrics but not the task body or raw controller trace.
- `trace`: uploads the full Phase controller step objects to the customer's private cloud stream. Treat this as potentially repository-sensitive data.

### Data-product consent

`data_product` is deliberately separate from premium telemetry.

- `none` (default): customer data is not contributed to the commercial aggregate corpus.
- `aggregate`: contribute a reduced benchmark record containing behavior names, validation outcomes, repair counts, latency, worker type/model, isolation backend, and similar operational fields.

The aggregate product stream excludes raw task text, cwd, source code, patches, stdout, prompts, account identity, and repository IDs. The reference server replaces account/run identity with a one-way run fingerprint before writing the product log.

Do not silently change `data_product` from `none` for existing customers. The commercial value is a benchmark network with explicit provenance and consent, not resale of customer repositories.

## Local reference cloud

For development:

```bash
phase cloud:dev 8787
# or
npm run cloud:dev
```

Defaults:

```text
API key: phase-dev-key
private stream: .phase/cloud/private.ndjson
product stream: .phase/cloud/product.ndjson
```

Set `PHASE_CLOUD_DEV_KEY` before starting the server to change the dev entitlement key.

## Premium product surface

The WebSocket transport is intentionally small. A hosted Phase Cloud can build higher-value features on the stream without changing the local agent interface:

- live multi-agent run monitoring,
- durable cross-machine run history,
- organization policy/validator distribution,
- anomaly and contamination alerts,
- team provenance search,
- agent/model comparison dashboards,
- benchmark percentile reports,
- fleet repair/failure analytics,
- opt-in aggregate benchmark datasets/API products.

The aggregate dataset is most defensible when sold as statistical benchmark intelligence: which agent/harness/policy combinations tend to require repairs, where validation fails, latency/cost distributions, and which repository-governance behavior sequences correlate with successful acceptance.

## Reference-server scope

`src/cloud-server.mjs` is a development/reference implementation, not a production SaaS backend. Production deployment still needs TLS termination, real account auth, billing/entitlement storage, rate limiting, durable message storage, retention controls, deletion/export flows, regional/privacy controls, abuse protection, and multi-tenant authorization.
