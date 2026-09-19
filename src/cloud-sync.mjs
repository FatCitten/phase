import { randomUUID, createHash } from 'node:crypto';

function sha256(value) { return createHash('sha256').update(String(value ?? '')).digest('hex'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function safeUrl(raw) {
  const u = new URL(String(raw));
  if (!['ws:', 'wss:'].includes(u.protocol)) throw new Error('Phase Cloud URL must use ws:// or wss://');
  return u.toString();
}
function waitFor(ws, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Phase Cloud ${event} timeout`)); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); ws.removeEventListener(event, onOk); ws.removeEventListener('error', onErr); };
    const onOk = (ev) => { cleanup(); resolve(ev); };
    const onErr = () => { cleanup(); reject(new Error('Phase Cloud websocket error')); };
    ws.addEventListener(event, onOk, { once: true });
    ws.addEventListener('error', onErr, { once: true });
  });
}

export function aggregateStep(step) {
  return {
    step: Number(step.step ?? 0),
    behavior: String(step.behavior ?? 'unknown'),
    isError: Boolean(step.isError),
    inspected: Boolean(step.state?.inspected),
    workerRuns: Number(step.state?.workerRuns ?? 0),
    validationAttempted: Boolean(step.state?.validationAttempted),
    validationPassed: Boolean(step.state?.validationPassed),
    repairs: Number(step.state?.repairs ?? 0),
    reviewed: Boolean(step.state?.reviewed),
    reviewPassed: Boolean(step.state?.reviewPassed),
    consolidated: Boolean(step.state?.consolidated),
    hasValidationCommand: Boolean(step.state?.hasValidationCommand),
    hasWorkingTreeDiff: Boolean(step.state?.hasWorkingTreeDiff)
  };
}

export function aggregateRunResult(result) {
  const trace = result?.controller?.trace ?? [];
  return {
    passed: Boolean(result?.passed),
    workerAdapter: result?.worker?.id ?? null,
    workerModel: result?.worker?.model ?? null,
    policy: result?.policy ?? null,
    wallTimeMs: Math.round(Number(result?.wallTimeMs ?? 0)),
    workerRuns: Number(result?.controller?.state?.workerRuns ?? 0),
    repairs: Number(result?.controller?.state?.repairs ?? 0),
    validationPassed: Boolean(result?.controller?.state?.validationPassed),
    reviewPassed: Boolean(result?.controller?.state?.reviewPassed),
    auditPassed: Boolean(result?.audit?.passed),
    osIsolation: result?.firewall?.osIsolation?.backend ?? null,
    hiddenCommands: Number(result?.firewall?.hiddenCommands ?? 0),
    behaviors: trace.map((x) => String(x.behavior ?? 'unknown')),
    errorSteps: trace.filter((x) => x.isError).length
  };
}

export class PhaseCloudClient {
  constructor(config = {}, context = {}) {
    this.enabled = Boolean(config.enabled && config.url);
    this.url = this.enabled ? safeUrl(config.url) : null;
    this.required = Boolean(config.required);
    this.apiKey = config.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : process.env.PHASE_CLOUD_API_KEY) ?? null;
    this.account = config.account ?? null;
    this.telemetry = String(config.telemetry ?? 'metrics');
    this.dataProduct = String(config.dataProduct ?? 'none');
    this.timeoutMs = Number(config.timeoutMs ?? 5000);
    this.context = { runId: context.runId ?? null, repositoryId: context.repositoryId ?? null, clientVersion: context.clientVersion ?? null };
    this.ws = null;
    this.connected = false;
    this.entitlements = null;
    this.sent = 0;
    this.acks = new Map();
    this.errors = [];
  }

  async connect() {
    if (!this.enabled) return false;
    if (!this.apiKey) {
      const e = new Error('Phase Cloud enabled but no API key is configured');
      if (this.required) throw e;
      this.errors.push(String(e)); return false;
    }
    try {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      await waitFor(ws, 'open', this.timeoutMs);
      const helloId = randomUUID();
      ws.send(JSON.stringify({ type: 'hello', id: helloId, apiKey: this.apiKey, account: this.account, protocol: 'phase-cloud-v1', context: this.context }));
      const auth = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Phase Cloud auth timeout')), this.timeoutMs);
        const onMessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data));
            if (msg.type !== 'hello.ack' || msg.replyTo !== helloId) return;
            clearTimeout(timer); ws.removeEventListener('message', onMessage);
            if (!msg.ok) reject(new Error(msg.error ?? 'Phase Cloud authentication failed'));
            else resolve(msg);
          } catch {}
        };
        ws.addEventListener('message', onMessage);
      });
      this.entitlements = auth.entitlements ?? {};
      if (!this.entitlements.premium) throw new Error('Phase Cloud account does not have premium entitlement');
      ws.addEventListener('message', (ev) => {
        try { const msg = JSON.parse(String(ev.data)); if (msg.type === 'ack' && msg.replyTo) this.acks.set(msg.replyTo, msg); } catch {}
      });
      this.connected = true;
      return true;
    } catch (e) {
      this.errors.push(String(e));
      try { this.ws?.close(); } catch {}
      this.connected = false;
      if (this.required) throw e;
      return false;
    }
  }

  async emit(type, privatePayload = {}, productPayload = null) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const id = randomUUID();
    const envelope = {
      type: 'event', id, event: String(type), at: new Date().toISOString(), context: this.context,
      private: this.telemetry === 'off' ? null : privatePayload,
      product: this.dataProduct === 'aggregate' ? productPayload : null,
      consent: { telemetry: this.telemetry, dataProduct: this.dataProduct }
    };
    this.ws.send(JSON.stringify(envelope));
    this.sent += 1;
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (this.acks.has(id)) { this.acks.delete(id); return true; }
      await sleep(10);
    }
    const e = new Error(`Phase Cloud ack timeout for ${type}`);
    this.errors.push(String(e));
    if (this.required) throw e;
    return false;
  }

  async close() {
    if (!this.ws) return;
    try { this.ws.close(1000, 'run complete'); } catch {}
    this.connected = false;
  }

  summary() {
    return { enabled: this.enabled, connected: this.connected, sent: this.sent, telemetry: this.telemetry, dataProduct: this.dataProduct, entitlements: this.entitlements, errors: this.errors };
  }
}

export function taskFingerprint(task) { return sha256(task).slice(0, 24); }
