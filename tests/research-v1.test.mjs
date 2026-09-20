import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeWorkflow } from '../src/phase-ir.mjs';
import { runWorkflow } from '../src/fiber-runtime.mjs';
import { FiberRenderer } from '../src/fiber-ui.mjs';
import { buildCorpus, deriveAllocationEpisodes, verifyCorpus } from '../src/corpus.mjs';
import { verifyResearchRun } from '../src/research.mjs';
import { computeFiberSignals } from '../src/signals.mjs';

test('sealed run reconstructs allocator episode from canonical buses alone',async()=>{
  const root=mkdtempSync(join(tmpdir(),'phase-v1-run-'));mkdirSync(join(root,'bin'));const agent=join(root,'bin','agent.mjs');writeFileSync(agent,"process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>{require('fs').writeFileSync('ok.txt','ok')})");
  // .cjs avoids ESM require ambiguity in temp repos.
  const cjs=join(root,'bin','agent.cjs');writeFileSync(cjs,"process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>{require('fs').writeFileSync('ok.txt','ok')})");
  const wf=normalizeWorkflow({cwd:root,objective:'produce marker',isolation:{enabled:false},fibers:[{id:'F1',objective:'write marker',agent:{adapter:'exec',argv:[process.execPath,cjs],prompt:'stdin'},tools:['read','edit','test'],validation:['test -f ok.txt']}]});
  const r=await runWorkflow(wf,{renderer:new FiberRenderer({enabled:false})});assert.equal(r.passed,true);assert.equal(verifyResearchRun(r.run_dir).passed,true);const e=deriveAllocationEpisodes(r.run_dir);assert.equal(e.length,1);assert.equal(e[0].fiber.id,'F1');assert.equal(e[0].state.vector.length,96);assert.equal(e[0].measurements.validation_passed,1);assert.ok(e[0].allocation.budget.context_tokens>0);
  const corpusDir=join(root,'corpus');const c=buildCorpus({experimentsDir:join(root,'.phase','experiments'),outDir:corpusDir});assert.equal(c.runs,1);assert.equal(c.episodes,1);assert.equal(verifyCorpus(corpusDir).passed,true);
});

test('unobserved telemetry is preserved as null, not fabricated zero',()=>{
  const s=computeFiberSignals({passed:true,worker_ok:true,wall_ms:1,allocation:{budget:{wall_ms:10,context_tokens:100,tool_calls:2,tokens:200}}});assert.equal(s.observed_input_tokens,null);assert.equal(s.observed_context_misses,null);assert.equal(s.observed_retries,null);
});
