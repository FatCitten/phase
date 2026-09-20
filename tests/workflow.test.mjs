import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { normalizeWorkflow } from '../src/phase-ir.mjs';
import { PHASE_ARCHITECTURE_SEED, seedExamples, seedHash } from '../src/phase-seeds.mjs';
import { encodeAllocationState, cosine } from '../src/phase-features.mjs';
import { PhaseAllocator } from '../src/allocator.mjs';
import { runWorkflow } from '../src/fiber-runtime.mjs';
import { FiberRenderer } from '../src/fiber-ui.mjs';
import { summarizeExperiment, verifyResearchEventLog } from '../src/research.mjs';
import { compileWorkflowDescription } from '../src/workflow-compiler.mjs';
import { computeFiberSignals, defaultAllocationObjective } from '../src/signals.mjs';

test('architecture seed is stable and contains allocation rather than project facts',()=>{
  assert.equal(PHASE_ARCHITECTURE_SEED.schema,'phase-allocator-seed-v1');
  assert.equal(seedHash().length,64);assert.ok(seedExamples().length>=4);
  assert.ok(PHASE_ARCHITECTURE_SEED.resources.includes('context_tokens'));
  assert.ok(PHASE_ARCHITECTURE_SEED.outputs.includes('route'));
});

test('workflow IR normalizes fibers and allocator emits bounded structured allocations',async()=>{
  const root=mkdtempSync(join(tmpdir(),'phase-wf-'));
  const wf=normalizeWorkflow({cwd:root,objective:'ship project',fibers:[{id:'F1',objective:'build feature',budget:{context_tokens:10000}}]});
  const a=await new PhaseAllocator().allocate({workflow:wf,fiber:wf.fibers[0],runtime:{context_misses:2},availableAgents:[{id:'fake',available:true}]});
  assert.equal(a.schema,'phase-allocation-v1');assert.equal(a.agent,'fake');assert.ok(a.budget.context_tokens<=10000);assert.equal(a.seed_hash,seedHash());assert.equal(a.state_vector.vector.length,96);
});



test('SLM allocator policy is constrained by fiber ceilings and allowed capabilities',async()=>{
  const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{const j=JSON.parse(body);assert.match(j.messages[0].content,/resource allocator/);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({agent:'fake',tools:['read','root-shell'],context_tokens:999999,wall_ms:9999999,tool_calls:999,action:'allocate'})}}]}));});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  try{
    const root=mkdtempSync(join(tmpdir(),'phase-model-'));const wf=normalizeWorkflow({cwd:root,objective:'x',fibers:[{id:'F1',objective:'y',agent:'auto',tools:['read'],budget:{context_tokens:8000,wall_ms:5000,tool_calls:4}}]});
    const a=await new PhaseAllocator({policy:'model',model:{base_url:`http://127.0.0.1:${port}/v1`,model:'test',required:true}}).allocate({workflow:wf,fiber:wf.fibers[0],availableAgents:[{id:'fake',available:true}]});
    assert.equal(a.policy,'model');assert.equal(a.agent,'fake');assert.deepEqual(a.tools,['read']);assert.equal(a.budget.context_tokens,8000);assert.equal(a.budget.wall_ms,5000);assert.equal(a.budget.tool_calls,4);
  }finally{await new Promise(r=>server.close(r));}
});
test('repository domains are strongly separated in allocator feature space',()=>{
  const a=mkdtempSync(join(tmpdir(),'phase-repo-a-')),b=mkdtempSync(join(tmpdir(),'phase-repo-b-'));
  const wa=normalizeWorkflow({cwd:a,objective:'same task'}),wb=normalizeWorkflow({cwd:b,objective:'same task'});
  const va=encodeAllocationState({workflow:wa,fiber:wa.fibers[0]}),vb=encodeAllocationState({workflow:wb,fiber:wb.fibers[0]});
  assert.notEqual(va.repository_id,vb.repository_id);assert.ok(cosine(va.vector,vb.vector)<0.65);
});



test('genuine signals remain separate from the experiment objective',()=>{
  const signals=computeFiberSignals({passed:true,worker_ok:true,wall_ms:250,allocation:{budget:{wall_ms:1000,context_tokens:4000,tool_calls:8}}});
  assert.equal(signals.validated_progress,1);assert.equal(signals.wall_budget_utilization,0.25);assert.equal(signals.allocated_context_tokens,4000);assert.equal(defaultAllocationObjective(signals),0.975);
});
test('fiber renderer exposes real CLI-style progress bars',()=>{
  let out='';const stream={isTTY:true,write:s=>{out+=s;}};const r=new FiberRenderer({stream,enabled:true});r.update('F1',{status:'running',label:'compile shader'});r.update('F1',{status:'done',label:'compile shader'});r.close();
  assert.match(out,/F1/);assert.match(out,/█/);assert.match(out,/100%/);
});

test('workflow runtime executes an arbitrary agent fiber and emits research artifacts',async()=>{
  const root=mkdtempSync(join(tmpdir(),'phase-fiber-'));mkdirSync(join(root,'scripts'),{recursive:true});
  const agent=join(root,'scripts','fake-agent.mjs');writeFileSync(agent,"import {writeFileSync} from 'node:fs'; process.stdin.resume(); let s=''; process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>{writeFileSync('done.txt',s.includes('FIBER F1')?'ok':'bad'); console.log('done')});");
  const wf=normalizeWorkflow({cwd:root,objective:'finish marker',isolation:{enabled:false},fibers:[{id:'F1',objective:'write done marker',agent:{adapter:'exec',argv:[process.execPath,agent],prompt:'stdin'},validation:["test \"$(cat done.txt)\" = ok"]}]});
  const r=await runWorkflow(wf,{renderer:new FiberRenderer({enabled:false})});assert.equal(r.passed,true);assert.equal(readFileSync(join(root,'done.txt'),'utf8'),'ok');
  const manifest=JSON.parse(readFileSync(join(r.run_dir,'manifest.json'),'utf8'));const result=JSON.parse(readFileSync(join(r.run_dir,'result.json'),'utf8'));assert.equal(manifest.schema,'phase-experiment-v1');assert.equal(result.summary.passed,true);assert.ok(readFileSync(join(r.run_dir,'events.ndjson'),'utf8').includes('fiber.allocated'));assert.equal(verifyResearchEventLog(join(r.run_dir,'events.ndjson')).passed,true);
});



test('natural-language workflow compiler can use any exec-style LLM adapter',async()=>{
  const root=mkdtempSync(join(tmpdir(),'phase-compile-'));const compiler=join(root,'compiler.mjs');
  writeFileSync(compiler,`process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>console.log(JSON.stringify({schema:'phase-workflow-v1',id:'compiled',objective:'ship demo',cwd:process.cwd(),fibers:[{id:'F1',objective:'build it',depends_on:[],agent:'auto',tools:['read'],validation:[]}]})))`);
  const wf=await compileWorkflowDescription({description:'build me a demo',cwd:root,worker:{adapter:'exec',argv:[process.execPath,compiler],prompt:'stdin'}});
  assert.equal(wf.id,'compiled');assert.equal(wf.fibers[0].objective,'build it');
});
test('research summary reports pass rate with confidence interval',()=>{
  const s=summarizeExperiment([{passed:true,wall_ms:10},{passed:false,wall_ms:30},{passed:true,wall_ms:20}]);assert.equal(s.n,3);assert.equal(s.success,2);assert.ok(s.pass_rate_95ci.low<s.pass_rate&&s.pass_rate_95ci.high>s.pass_rate);
});
