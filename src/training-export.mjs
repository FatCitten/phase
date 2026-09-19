import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BrainStore } from './store.mjs';
import { compileBehaviorDataset } from './behavior-forge.mjs';
import { sha256 } from './util.mjs';

function jsonl(rows){return rows.map(x=>JSON.stringify(x)).join('\n')+(rows.length?'\n':'');}

export function exportRunTrainingData({ runResult, runDir, includePrivate = false }) {
  const out = resolve(runDir, 'training'); mkdirSync(out, { recursive: true });
  const suite = { brainDb: runResult.brainDb, results: [{ task: runResult.runId, prompt: runResult.task, result: { ...runResult.controller, passed: runResult.passed, ledgerHeadBeforeHidden: runResult.ledgerHeadBeforeHidden } }] };
  const suitePath = resolve(out, 'suite-result.json'); writeFileSync(suitePath, JSON.stringify(suite, null, 2));
  const behavior = compileBehaviorDataset({ suiteResultPath: suitePath, outDir: out });
  const outcome = {
    schema:'phase-run-outcome-v1', runId:runResult.runId, passed:runResult.passed,
    worker:runResult.worker, policy:runResult.policy,
    publicPassed:(runResult.publicValidation??[]).every(x=>x.status===0),
    hiddenPassed:(runResult.hiddenValidation??[]).every(x=>x.status===0),
    cloudCalls:(runResult.controller?.trace??[]).filter(x=>['delegate','repair'].includes(x.behavior)).length,
    repairs:(runResult.controller?.trace??[]).filter(x=>x.behavior==='repair').length,
    steps:(runResult.controller?.trace??[]).length,
    wallTimeMs:runResult.wallTimeMs,
    ledgerHead:runResult.ledgerHeadBeforeHidden
  };
  const outcomePath = resolve(out, 'outcome.jsonl'); writeFileSync(outcomePath, jsonl([outcome]));
  let privatePath = null;
  if (includePrivate) {
    const store = new BrainStore(runResult.brainDb);
    try {
      const sid=runResult.controller?.sessionId;
      const full={schema:'phase-private-trace-v1',runId:runResult.runId,sessionId:sid,observations:store.listSessionObservations(sid),actions:store.listSessionActions(sid)};
      privatePath=resolve(out,'PRIVATE.full-trace.jsonl');writeFileSync(privatePath,jsonl([full]));
    } finally { store.close(); }
  }
  const manifest={schema:'phase-training-export-v1',behavior,outcome:{path:outcomePath,sha256:sha256(readFileSync(outcomePath))},privateTrace:privatePath,privacy:{defaultExport:'behavior+outcome',patchTextInTargets:false,hiddenTestBodies:false,privateTraceOptIn:Boolean(includePrivate)}};
  writeFileSync(resolve(out,'export-manifest.json'),JSON.stringify(manifest,null,2));
  return manifest;
}
