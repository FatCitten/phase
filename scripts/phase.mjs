#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runHarness } from '../src/harness-runner.mjs';
import { writeRunReport } from '../src/run-report.mjs';
import { startDashboard } from '../src/dashboard-server.mjs';
import { exportRunTrainingData } from '../src/training-export.mjs';
import { buildDataset } from '../src/dataset.mjs';
import { detectAvailableAdapters } from '../src/adapters.mjs';
import { startPhaseCloudServer } from '../src/cloud-server.mjs';
import { loadWorkflow, normalizeWorkflow } from '../src/phase-ir.mjs';
import { compileWorkflowDescription } from '../src/workflow-compiler.mjs';
import { runWorkflow } from '../src/fiber-runtime.mjs';
import { FiberRenderer } from '../src/fiber-ui.mjs';
import { PHASE_ARCHITECTURE_SEED, seedExamples, seedHash } from '../src/phase-seeds.mjs';
import { summarizeExperiment, verifyResearchEventLog } from '../src/research.mjs';

function usage(){console.log(`Phase v0.9\n\nCore workflow runtime\n  phase workflow:init <workflow.json> [repo]\n  phase workflow:compile <description|file> [out.json]\n  phase workflow:run <workflow.json> [--plain]\n  phase seed [out.json]\n  phase skill\n  phase research:verify <experiment-dir>\n  phase research:summarize <experiment-dir...>\n  phase allocator:dataset [experiments-dir] [out-dir]\n  phase allocator:jit [experiments-dir] [dataset-dir] [model-dir]\n\nCompatibility / tooling\n  phase init <config.json> [repo]\n  phase agents\n  phase run <config.json>\n  phase report <result.json> [out.html]\n  phase export <result.json> [--private]\n  phase ui [runs-dir] [--port 4317]\n  phase dataset <runs-dir> <out-dir> [--portable]\n  phase cloud:dev [port]\n`)}
function template(cwd){return{id:'fix-example',cwd,task:'Describe the coding task here',worker:{adapter:'auto'},verify:{public:['npm test'],hidden:['npm test -- --runInBand']},hidden:{install:[{from:'/absolute/operator-only/hidden.test.js',to:'tests/.phase-hidden.test.js'}],paths:['tests/.phase-hidden.test.js']},isolation:{enabled:true,required:true,read:[]},governor:{policy:'heuristic',max_repairs:2},training:{enabled:true,export_full_private_trace:false},report:{enabled:true,title:'Phase coding run'}};}
function workflowTemplate(cwd){return normalizeWorkflow({id:'project',cwd,objective:'Describe the finished project outcome',constraints:[],decisions:[],defaults:{agent:'auto',budget:{tokens:24000,context_tokens:12000,wall_ms:900000,tool_calls:40}},fibers:[{id:'F1',objective:'Implement the first independently verifiable unit of work',depends_on:[],agent:'auto',tools:['read','edit','test'],validation:[]}]},{baseDir:cwd});}
function findExperimentResults(p,out=[]){p=resolve(p);if(!existsSync(p))return out;const s=statSync(p);if(s.isFile()){if(basename(p)==='result.json')out.push(p);return out;}for(const n of readdirSync(p))findExperimentResults(join(p,n),out);return out;}

const [cmd,...args]=process.argv.slice(2);if(!cmd){usage();process.exit(64)}
if(cmd==='workflow:init'){
  const out=resolve(args[0]??'phase-workflow.json');const cwd=resolve(args[1]??'.');mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(workflowTemplate(cwd),null,2));console.log(`Wrote ${out}`);
}else if(cmd==='workflow:compile'){
  if(!args[0]){usage();process.exit(64)}const description=existsSync(resolve(args[0]))?readFileSync(resolve(args[0]),'utf8'):args[0];const out=resolve(args[1]??'phase-workflow.json');const wf=await compileWorkflowDescription({description,cwd:process.cwd(),worker:{adapter:process.env.PHASE_AGENT??'auto'}});writeFileSync(out,JSON.stringify(wf,null,2));console.log(`Wrote ${out}`);
}else if(cmd==='workflow:run'){
  if(!args[0]){usage();process.exit(64)}const wf=loadWorkflow(args[0]);const plain=args.includes('--plain');const renderer=plain?new FiberRenderer({enabled:false}):undefined;const r=await runWorkflow(wf,{renderer,experiment:process.env.PHASE_EXPERIMENT??null});if(plain){for(const x of r.outcomes)console.log(`${x.passed?'✓':'✗'} ${x.fiber_id} ${Math.round(x.wall_ms)}ms`);}console.log(`\n${r.passed?'PASS':'FAIL'}  ${r.completed}/${r.fibers} fibers\nresearch: ${r.run_dir}`);process.exitCode=r.passed?0:2;
}else if(cmd==='seed'){
  const payload={...PHASE_ARCHITECTURE_SEED,sha256:seedHash(),examples:seedExamples()};if(args[0]){const p=resolve(args[0]);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,JSON.stringify(payload,null,2));console.log(p);}else console.log(JSON.stringify(payload,null,2));
}else if(cmd==='skill'){
  console.log(resolve('skills/phase/SKILL.md'));
}else if(cmd==='research:verify'){
  if(!args[0]){usage();process.exit(64)}const p=resolve(args[0]);const log=statSync(p).isDirectory()?join(p,'events.ndjson'):p;const v=verifyResearchEventLog(log);console.log(JSON.stringify(v,null,2));process.exitCode=v.passed?0:2;
}else if(cmd==='allocator:dataset'){
  const r=spawnSync(process.execPath,[resolve('scripts/compile-allocator-dataset.mjs'),resolve(args[0]??'.phase/experiments'),resolve(args[1]??'.phase/allocator-dataset')],{stdio:'inherit'});process.exitCode=r.status??1;
}else if(cmd==='allocator:jit'){
  const argv=[resolve('scripts/jit-allocator.mjs'),resolve(args[0]??'.phase/experiments'),resolve(args[1]??'.phase/allocator-dataset'),resolve(args[2]??'.phase/models/allocator')];const r=spawnSync(process.execPath,argv,{stdio:'inherit'});process.exitCode=r.status??1;
}else if(cmd==='research:summarize'){
  const roots=args.length?args:['.phase/experiments'];const files=roots.flatMap(x=>findExperimentResults(x));const rows=[];for(const p of files){try{const x=JSON.parse(readFileSync(p,'utf8'));if(x.schema==='phase-experiment-v1'&&x.summary)rows.push({passed:Boolean(x.summary.passed),wall_ms:Number(x.summary.wall_ms??0),run_id:x.run_id,workflow_id:x.workflow_id});}catch{}}
  console.log(JSON.stringify({...summarizeExperiment(rows),runs:rows},null,2));
}else if(cmd==='init'){
  const out=resolve(args[0]??'../phase-task.json');const cwd=resolve(args[1]??'.');mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(template(cwd),null,2));console.log(`Wrote ${out}\nKeep this operator config outside the agent worktree.`);
}else if(cmd==='agents'){
  const rows=detectAvailableAdapters();for(const x of rows)console.log(`${x.available?'✓':'·'} ${x.id.padEnd(10)} ${x.label}${x.executable?`  (${x.executable})`:''}`);console.log('\nUse worker.adapter="auto" to select the first available agent, PHASE_AGENT=<id> to force one, or worker.manifest for any external harness.');
}else if(cmd==='run'){
  if(!args[0]){usage();process.exit(64)}const r=await runHarness(args[0],{onStep:(x)=>console.log(`${String(x.step).padStart(2,'0')} ${x.behavior.toUpperCase()}${x.isError?' !':''}`)});console.log(`\n${r.passed?'PASS':'FAIL'}\nresult: ${r.resultPath}${r.reportPath?`\nreport: ${r.reportPath}`:''}`);process.exitCode=r.passed?0:2;
}else if(cmd==='report'){
  const p=resolve(args[0]??'');if(!existsSync(p))throw new Error('result.json not found');const x=JSON.parse(readFileSync(p,'utf8'));const out=resolve(args[1]??join(dirname(p),'report.html'));writeRunReport(x,out,{title:x.task??basename(dirname(p))});console.log(out);
}else if(cmd==='export'){
  const p=resolve(args[0]??'');if(!existsSync(p))throw new Error('result.json not found');const x=JSON.parse(readFileSync(p,'utf8'));const m=exportRunTrainingData({runResult:x,runDir:dirname(p),includePrivate:args.includes('--private')});console.log(JSON.stringify(m,null,2));
}else if(cmd==='dataset'){
  const runs=resolve(args[0]??'.phase/runs');const out=resolve(args[1]??'phase-dataset');const m=buildDataset({runsDir:runs,outDir:out,portable:args.includes('--portable')});console.log(JSON.stringify(m,null,2));
}else if(cmd==='ui'){
  const p=args.find(x=>!x.startsWith('--'))??resolve('.phase','runs');const pi=args.indexOf('--port');const port=pi>=0?Number(args[pi+1]):4317;const d=startDashboard({runsDir:p,port});console.log(`Phase UI ${d.url}\nRuns: ${d.runsDir}`);
}else if(cmd==='cloud:dev'){
  const port=Number(args[0]??process.env.PHASE_CLOUD_PORT??8787);const key=process.env.PHASE_CLOUD_DEV_KEY??'phase-dev-key';const d=await startPhaseCloudServer({host:'127.0.0.1',port,apiKeys:{[key]:{account:'dev',premium:true}},privateLog:resolve('.phase/cloud/private.ndjson'),productLog:resolve('.phase/cloud/product.ndjson')});console.log(`Phase Cloud dev server ${d.url}\nAPI key: ${key}\nPrivate: ${resolve('.phase/cloud/private.ndjson')}\nProduct: ${resolve('.phase/cloud/product.ndjson')}`);
}else{usage();process.exit(64)}
