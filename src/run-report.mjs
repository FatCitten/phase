import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const js = (x) => JSON.stringify(x).replace(/</g, '\\u003c');
const pct = (n,d) => d ? `${Math.round(n/d*100)}%` : '—';

function validationRows(result) {
  const pub = result.publicValidation ?? [];
  const hid = result.hiddenValidation ?? [];
  return [
    ...pub.map((x,i)=>({scope:'PUBLIC',name:x.label??`Public ${i+1}`,status:x.status,stdout:x.stdout,stderr:x.stderr})),
    ...hid.map((x,i)=>({scope:'HIDDEN',name:x.label??`Hidden ${i+1}`,status:x.status,stdout:x.stdout,stderr:x.stderr}))
  ];
}
function stageNode(x, i) {
  const status = x.isError ? 'error' : (x.behavior === 'finish' && !x.success ? 'error' : 'ok');
  return `<button class="stage ${status}" data-step="${i}" aria-label="Open ${esc(x.behavior)} details"><span class="stage-kicker">${String(i+1).padStart(2,'0')}</span><strong>${esc(x.behavior).toUpperCase()}</strong><span>${x.isError?'error':'complete'}</span></button>`;
}

export function renderRunReport(result, { title = 'Phase Run' } = {}) {
  const trace = result.controller?.trace ?? result.result?.trace ?? [];
  const validations = validationRows(result);
  const hiddenPass = result.hiddenValidation?.filter(x=>x.status===0).length ?? 0;
  const hiddenTotal = result.hiddenValidation?.length ?? 0;
  const publicPass = result.publicValidation?.filter(x=>x.status===0).length ?? 0;
  const publicTotal = result.publicValidation?.length ?? 0;
  const workerCalls = trace.filter(x=>['delegate','repair'].includes(x.behavior)).length;
  const repairs = trace.filter(x=>x.behavior==='repair').length;
  const firewall = result.firewall ?? {};
  const payload = { trace, validations, result };
  const css = `
:root{color-scheme:dark;--bg:#071019;--panel:#0d1824;--panel2:#111f2e;--line:#26384a;--text:#eef7ff;--muted:#8ba3b8;--good:#4ce5a7;--bad:#ff6f7d;--accent:#77b7ff;--warn:#ffd166;--violet:#b49cff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% -10%,#16304d 0,transparent 34%),radial-gradient(circle at 100% 10%,#241c46 0,transparent 27%),var(--bg);font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--text)}main{max-width:1480px;margin:auto;padding:32px}.top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.eyebrow{text-transform:uppercase;letter-spacing:.16em;font-size:12px;color:var(--accent);font-weight:800}h1{font-size:clamp(34px,5vw,64px);line-height:1;margin:8px 0 12px;max-width:950px}.status{padding:12px 18px;border-radius:999px;font-weight:900;letter-spacing:.08em;background:${result.passed?'rgba(76,229,167,.14)':'rgba(255,111,125,.14)'};color:${result.passed?'var(--good)':'var(--bad)'};border:1px solid currentColor}.sub{color:var(--muted);max-width:850px}.metrics{display:grid;grid-template-columns:repeat(6,minmax(130px,1fr));gap:12px;margin:28px 0}.metric,.panel{background:linear-gradient(180deg,rgba(17,31,46,.95),rgba(10,22,33,.95));border:1px solid var(--line);border-radius:18px;box-shadow:0 18px 50px rgba(0,0,0,.18)}.metric{padding:18px}.metric b{display:block;font-size:28px}.metric span{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em}.panel{padding:22px;margin:16px 0}.panel h2{margin:0 0 16px;font-size:18px}.flow{display:flex;align-items:stretch;gap:9px;overflow:auto;padding:8px 2px 14px}.stage{appearance:none;min-width:150px;background:#0a1520;border:1px solid var(--line);border-radius:15px;padding:15px;color:var(--text);text-align:left;cursor:pointer;position:relative}.stage:after{content:'→';position:absolute;right:-12px;top:38%;color:#557086;font-size:20px}.stage:last-child:after{display:none}.stage.ok{border-color:rgba(76,229,167,.45)}.stage.error{border-color:rgba(255,111,125,.6)}.stage strong{display:block;margin:4px 0}.stage span{font-size:11px;color:var(--muted)}.stage-kicker{color:var(--accent)!important}.firewall{display:grid;grid-template-columns:1fr 90px 1fr;gap:18px;align-items:center}.wall{height:175px;border:1px solid rgba(255,209,102,.6);border-radius:14px;background:repeating-linear-gradient(135deg,rgba(255,209,102,.16) 0 9px,transparent 9px 18px);display:flex;align-items:center;justify-content:center;writing-mode:vertical-rl;font-weight:900;letter-spacing:.13em;color:var(--warn)}.side{padding:14px}.side h3{margin-top:0}.side ul{padding-left:18px;color:var(--muted)}.grid{display:grid;grid-template-columns:1.15fr .85fr;gap:16px}.checks{width:100%;border-collapse:collapse}.checks td,.checks th{padding:11px 9px;border-bottom:1px solid var(--line);text-align:left}.checks th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.1em}.pass{color:var(--good)}.fail{color:var(--bad)}pre{white-space:pre-wrap;word-break:break-word;background:#06101a;border:1px solid #1b3145;padding:14px;border-radius:12px;color:#bcd2e5;max-height:360px;overflow:auto}.privacy{display:flex;gap:12px;flex-wrap:wrap}.chip{padding:8px 10px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:12px}.chip.good{color:var(--good);border-color:rgba(76,229,167,.45)}dialog{width:min(900px,92vw);background:#0b1723;border:1px solid #36516a;border-radius:18px;color:var(--text);padding:0;box-shadow:0 30px 90px #000}dialog header{display:flex;justify-content:space-between;padding:18px 20px;border-bottom:1px solid var(--line)}dialog article{padding:20px}button.close{background:transparent;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:7px 10px}@media(max-width:950px){.metrics{grid-template-columns:repeat(2,1fr)}.grid,.firewall{grid-template-columns:1fr}.wall{height:60px;writing-mode:horizontal-tb}.top{flex-direction:column}}
`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Phase</title><style>${css}</style></head><body><main>
<section class="top"><div><div class="eyebrow">Phase Harness · Auditable Coding Run</div><h1>${esc(title)}</h1><p class="sub">${esc(result.task ?? '')}</p></div><div class="status">${result.passed?'PASS':'FAIL'}</div></section>
<section class="metrics"><div class="metric"><b>${trace.length}</b><span>Governor steps</span></div><div class="metric"><b>${workerCalls}</b><span>Cloud calls</span></div><div class="metric"><b>${repairs}</b><span>Repairs</span></div><div class="metric"><b>${publicTotal?`${publicPass}/${publicTotal}`:'—'}</b><span>Public checks</span></div><div class="metric"><b>${hiddenTotal?`${hiddenPass}/${hiddenTotal}`:'—'}</b><span>Hidden checks</span></div><div class="metric"><b>${Math.round(result.wallTimeMs??result.controller?.wallTimeMs??0)}ms</b><span>Wall time</span></div></section>
<section class="panel"><h2>Repository behavior graph</h2><div class="flow">${trace.map(stageNode).join('')}</div></section>
<section class="panel"><h2>Hidden evaluator firewall</h2><div class="firewall"><div class="side"><h3>Agent-visible side</h3><ul><li>Task prompt</li><li>Repository files</li><li>Public validation output</li><li>Phase memories with receipts</li></ul></div><div class="wall">FIREWALL</div><div class="side"><h3>Evaluator side</h3><ul><li>${hiddenTotal} hidden validation command(s)</li><li>${firewall.hiddenAssetsInstalled??0} hidden asset(s) materialized after agent stop</li><li>Brain frozen: ${firewall.brainFrozen?'yes':'no'}</li><li>Contamination audit: ${firewall.auditPassed?'pass':'fail'}</li></ul></div></div></section>
<div class="grid"><section class="panel"><h2>Verification</h2><table class="checks"><thead><tr><th>Scope</th><th>Check</th><th>Status</th></tr></thead><tbody>${validations.map((x,i)=>`<tr><td>${esc(x.scope)}</td><td>${esc(x.name)}<details><summary>output</summary><pre>${esc((x.stderr||x.stdout||'(no output)').slice(0,6000))}</pre></details></td><td class="${x.status===0?'pass':'fail'}">${x.status===0?'PASS':'FAIL'} · ${x.status}</td></tr>`).join('')||'<tr><td colspan="3">No checks recorded.</td></tr>'}</tbody></table></section><section class="panel"><h2>Training artifact</h2><div class="privacy"><span class="chip good">behavior targets only</span><span class="chip good">hidden bodies excluded</span><span class="chip good">patch text excluded by default</span><span class="chip">ledger ${esc(String(result.ledgerHeadBeforeHidden??'').slice(0,12))}</span></div><p class="sub">Each validated run can export state → behavior → outcome examples for SLM or LLM training. Private full traces remain local unless explicitly enabled.</p></section></div>
<section class="panel"><h2>Run metadata</h2><pre>${esc(JSON.stringify({runId:result.runId,worker:result.worker,policy:result.policy,brainDb:result.brainDb,phaseIndex:result.phaseIndex,tags:result.tags},null,2))}</pre></section>
<dialog id="detail"><header><strong id="detailTitle">Step</strong><button class="close" onclick="detail.close()">Close</button></header><article><pre id="detailBody"></pre></article></dialog>
<script>const DATA=${js(payload)};const detail=document.getElementById('detail');document.querySelectorAll('.stage').forEach(b=>b.onclick=()=>{const x=DATA.trace[Number(b.dataset.step)];document.getElementById('detailTitle').textContent=(x.behavior||'step').toUpperCase();document.getElementById('detailBody').textContent=JSON.stringify(x,null,2);detail.showModal();});</script>
</main></body></html>`;
}

export function writeRunReport(result, path, options = {}) {
  const out = resolve(path); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, renderRunReport(result, options)); return out;
}
