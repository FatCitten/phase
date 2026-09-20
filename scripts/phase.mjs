#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadWorkflow, normalizeWorkflow } from '../src/phase-ir.mjs';
import { compileWorkflowDescription } from '../src/workflow-compiler.mjs';
import { runWorkflow } from '../src/fiber-runtime.mjs';
import { FiberRenderer } from '../src/fiber-ui.mjs';
import { detectAvailableAdapters } from '../src/adapters.mjs';
import { verifyResearchRun, summarizeExperiment } from '../src/research.mjs';
import { verifyPhaseBin, readPhaseBin, phaseBinTail } from '../src/phasebin.mjs';
import { buildCorpus, verifyCorpus } from '../src/corpus.mjs';
import { disassembleRun, loadSymbols, rawHex, replaySummary, streamName } from '../src/trace.mjs';
import { STREAM, formatPacket } from '../src/isa.mjs';

function usage(){console.log(`Phase v1.0 — SLM OS for cognitive resource allocation\n\n  phase init [workflow.json] [repo]\n  phase compile <description|file> [workflow.json]\n  phase run <workflow.json> [--raw|--plain]\n  phase status [experiments-dir]\n  phase trace <run-dir> [--state] [--follow]\n  phase raw <run-dir|phasebin> [control|signals|state] [--hex]\n  phase disasm <phasebin>\n  phase verify <run-dir|corpus-dir|phasebin>\n  phase replay <run-dir>\n  phase corpus [experiments-dir] [out-dir]\n  phase train [experiments-dir] [model-dir]\n  phase agents\n  phase skill\n`)}
function workflowTemplate(cwd){return normalizeWorkflow({id:'project',cwd,objective:'Describe the finished project outcome',constraints:[],decisions:[],defaults:{agent:'auto',budget:{tokens:24000,context_tokens:12000,wall_ms:900000,tool_calls:40}},fibers:[{id:'F1',objective:'Implement the first independently verifiable unit of work',depends_on:[],agent:'auto',tools:['read','edit','test'],validation:[]}]},{baseDir:cwd});}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function walkResults(p,out=[]){if(!existsSync(p))return out;const s=statSync(p);if(s.isFile()){if(basename(p)==='result.json')out.push(p);return out;}for(const n of readdirSync(p))walkResults(join(p,n),out);return out;}
function resolveBus(run,bus='control'){const m={control:'control.phasebin',ctrl:'control.phasebin',signals:'signals.phasebin',signal:'signals.phasebin',sig:'signals.phasebin',state:'state.phasebin'};return join(resolve(run),m[bus]??bus);}

const [cmd,...args]=process.argv.slice(2);if(!cmd||cmd==='--help'||cmd==='-h'||cmd==='help'){usage();process.exit(0);}if(cmd==='--version'||cmd==='-v'){console.log('1.0.0');process.exit(0);}
if(cmd==='init'){
  const out=resolve(args[0]??'phase-workflow.json'),cwd=resolve(args[1]??'.');mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(workflowTemplate(cwd),null,2));console.log(`Wrote ${out}`);
}else if(cmd==='compile'){
  if(!args[0]){usage();process.exit(64);}const description=existsSync(resolve(args[0]))?readFileSync(resolve(args[0]),'utf8'):args[0];const out=resolve(args[1]??'phase-workflow.json');const wf=await compileWorkflowDescription({description,cwd:process.cwd(),worker:{adapter:process.env.PHASE_AGENT??'auto'}});writeFileSync(out,JSON.stringify(wf,null,2));console.log(`Wrote ${out}`);
}else if(cmd==='run'){
  if(!args[0]){usage();process.exit(64);}const wf=loadWorkflow(args[0]);const raw=args.includes('--raw'),plain=args.includes('--plain')||raw;const renderer=plain?new FiberRenderer({enabled:false}):undefined;const onPacket=raw?(p,m)=>console.log(`${streamName(m.stream).padEnd(5)} ${formatPacket(p,{symbols:m.symbols})}`):null;const r=await runWorkflow(wf,{renderer,experiment:process.env.PHASE_EXPERIMENT??null,onPacket});if(plain&&!raw)for(const x of r.outcomes)console.log(`${x.passed?'✓':'✗'} ${x.fiber_id} ${Math.round(x.wall_ms)}ms`);console.log(`\n${r.passed?'PASS':'FAIL'}  ${r.completed}/${r.fibers} fibers\nrun: ${r.run_dir}`);process.exitCode=r.passed?0:2;
}else if(cmd==='status'){
  const root=resolve(args[0]??'.phase/experiments');const files=walkResults(root).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs).slice(0,20);if(!files.length){console.log('No sealed Phase runs.');process.exit(0);}for(const p of files){try{const x=JSON.parse(readFileSync(p,'utf8'));console.log(`${x.passed?'✓':'✗'} ${String(x.workflow_id??'').padEnd(20)} ${String(x.completed??0).padStart(2)}/${String(x.fibers??0).padEnd(2)} ${String(Math.round(x.wall_ms??0)).padStart(7)}ms  ${dirname(p)}`);}catch{}}
}else if(cmd==='trace'){
  if(!args[0]){usage();process.exit(64);}const run=resolve(args[0]),includeState=args.includes('--state'),follow=args.includes('--follow');if(!follow){for(const line of disassembleRun(run,{includeState}))console.log(line);}else{const files=[['control.phasebin',STREAM.CONTROL],['signals.phasebin',STREAM.SIGNAL],['state.phasebin',STREAM.STATE]],pos=new Map(files.map(([f])=>[f,0]));let idle=0;while(true){let emitted=0;let symbols={};try{symbols=loadSymbols(run);}catch{}for(const [file,stream] of files){if(stream===STREAM.STATE&&!includeState)continue;const p=join(run,file);if(!existsSync(p))continue;const t=phaseBinTail(p,{fromRecord:pos.get(file)??0});pos.set(file,t.next);for(const packet of t.packets){console.log(`${streamName(stream).padEnd(5)} ${formatPacket(packet,{symbols})}`);emitted++;}}if(emitted)idle=0;else idle++;if(existsSync(join(run,'SEALED'))&&idle>=2)break;await sleep(150);}}
}else if(cmd==='raw'){
  if(!args[0]){usage();process.exit(64);}let p=resolve(args[0]);if(statSync(p).isDirectory())p=resolveBus(p,args.find((x,i)=>i>0&&!x.startsWith('--'))??'control');if(args.includes('--hex'))for(const line of rawHex(p))console.log(line);else{const x=readPhaseBin(p);console.log(JSON.stringify(x.header,null,2));for(const packet of x.packets)console.log(formatPacket(packet));}
}else if(cmd==='disasm'){
  if(!args[0]){usage();process.exit(64);}const x=readPhaseBin(resolve(args[0]));console.log(`; PHASEBIN v${x.header.version} stream=${streamName(x.header.stream)} records=${x.packets.length} sha256=${x.sha256}`);for(const p of x.packets)console.log(formatPacket(p));
}else if(cmd==='verify'){
  if(!args[0]){usage();process.exit(64);}const p=resolve(args[0]);let v;if(statSync(p).isFile())v=verifyPhaseBin(p);else if(existsSync(join(p,'corpus.json')))v=verifyCorpus(p);else v=verifyResearchRun(p);console.log(JSON.stringify(v,null,2));process.exitCode=v.passed?0:2;
}else if(cmd==='replay'){
  if(!args[0]){usage();process.exit(64);}console.log(JSON.stringify(replaySummary(resolve(args[0])),null,2));
}else if(cmd==='corpus'){
  const r=buildCorpus({experimentsDir:resolve(args[0]??'.phase/experiments'),outDir:resolve(args[1]??'.phase/corpus'),strict:true});console.log(JSON.stringify(r,null,2));
}else if(cmd==='train'){
  const experiments=resolve(args[0]??'.phase/experiments'),model=resolve(args[1]??'.phase/models/allocator'),corpus=resolve('.phase/corpus');let r=spawnSync(process.execPath,[resolve('scripts/compile-allocator-dataset.mjs'),experiments,corpus],{stdio:'inherit'});if((r.status??1)!==0){process.exitCode=r.status??1;}else{const dataset=join(corpus,'allocator-chat.jsonl');r=spawnSync('python3',[resolve('training/train_allocator.py'),dataset,'--output',model],{stdio:'inherit'});process.exitCode=r.status??1;}
}else if(cmd==='agents'){
  for(const x of detectAvailableAdapters())console.log(`${x.available?'✓':'·'} ${x.id.padEnd(10)} ${x.label}${x.executable?`  (${x.executable})`:''}`);
}else if(cmd==='skill'){
  console.log(resolve('skills/phase/SKILL.md'));
}else{usage();process.exit(64);}
