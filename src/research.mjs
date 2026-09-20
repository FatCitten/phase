import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { seedHash, PHASE_ARCHITECTURE_SEED } from './phase-seeds.mjs';
import { workflowHash } from './phase-ir.mjs';
import { gitSnapshot, stableJson } from './util.mjs';
import { PhaseBinWriter, verifyPhaseBin } from './phasebin.mjs';
import { STREAM, fiberNumber, symbol32 } from './isa.mjs';

const sha=(x)=>createHash('sha256').update(Buffer.isBuffer(x)?x:(typeof x==='string'?x:stableJson(x))).digest('hex');
const fileSha=(p)=>sha(readFileSync(p));

export class ResearchRun {
  constructor({ workflow, outDir, seed = PHASE_ARCHITECTURE_SEED, experiment = null, onPacket = null }) {
    this.id=randomUUID();this.workflow=workflow;this.dir=resolve(outDir);this.seed=seed;this.experiment=experiment;this.startedAt=new Date().toISOString();mkdirSync(this.dir,{recursive:true});
    this.workflowPath=join(this.dir,'workflow.json');this.symbolsPath=join(this.dir,'symbols.ndjson');this.events=join(this.dir,'events.ndjson');this.controlPath=join(this.dir,'control.phasebin');this.signalPath=join(this.dir,'signals.phasebin');this.statePath=join(this.dir,'state.phasebin');
    writeFileSync(this.workflowPath,JSON.stringify(workflow,null,2));writeFileSync(this.symbolsPath,'');writeFileSync(this.events,'');
    this.prevHash='0'.repeat(64);this.count=0;this.symbols=new Set();this.symbolTable={};this.seedSha=seedHash(seed);this.clockStart=performance.now();
    const packetCb=onPacket?(p,m)=>onPacket(p,{...m,symbols:this.symbolTable}):null;
    this.control=new PhaseBinWriter(this.controlPath,{stream:STREAM.CONTROL,runId:this.id,seedHash:this.seedSha,onPacket:packetCb,clockStart:this.clockStart});
    this.signals=new PhaseBinWriter(this.signalPath,{stream:STREAM.SIGNAL,runId:this.id,seedHash:this.seedSha,onPacket:packetCb,clockStart:this.clockStart});
    this.state=new PhaseBinWriter(this.statePath,{stream:STREAM.STATE,runId:this.id,seedHash:this.seedSha,onPacket:packetCb,clockStart:this.clockStart});
    for(let i=0;i<workflow.fibers.length;i++)this.symbol('fiber',workflow.fibers[i].id,i+1,workflow.fibers[i].objective);
  }
  fiber(id){return fiberNumber(id,this.workflow);}
  symbol(kind,label,id=symbol32(label),detail=null){const key=`${kind}:${id}`;if(this.symbols.has(key))return id;this.symbols.add(key);(this.symbolTable[kind]??={})[String(id)]=String(label);appendFileSync(this.symbolsPath,JSON.stringify({kind,id,label:String(label),detail})+'\n');return id;}
  fiberArg(fiber){if(fiber&&typeof fiber==='object'&&fiber.id)return this.fiber(fiber.id);return typeof fiber==='string'?this.fiber(fiber):Number(fiber??0);}
  instruction(opcode,{fiber=0,flags=0,a=0,b=0,value=0}={}){return this.control.packet({opcode,flags,fiber:this.fiberArg(fiber),a,b,value});}
  signal(opcode,{fiber=0,flags=0,a=0,b=0,value=0}={}){return this.signals.packet({opcode,flags,fiber:this.fiberArg(fiber),a,b,value});}
  statePacket(opcode,{fiber=0,flags=0,a=0,b=0,value=0}={}){return this.state.packet({opcode,flags,fiber:this.fiberArg(fiber),a,b,value});}
  event(type,payload={}){
    const body={schema:'phase-derived-event-v1',run_id:this.id,seq:++this.count,at:new Date().toISOString(),mono_ms:Number(performance.now().toFixed(3)),type,payload,prev_sha256:this.prevHash};
    const row={...body,sha256:sha(body)};this.prevHash=row.sha256;appendFileSync(this.events,JSON.stringify(row)+'\n');return row;
  }
  finish(summary){
    this.control.close();this.signals.close();this.state.close();
    const control=verifyPhaseBin(this.controlPath),signals=verifyPhaseBin(this.signalPath),state=verifyPhaseBin(this.statePath);if(!control.passed||!signals.passed||!state.passed)throw new Error(`canonical packet verification failed: ${JSON.stringify({control:control.failures,signals:signals.failures,state:state.failures})}`);
    const canonical={
      workflow:{file:'workflow.json',sha256:fileSha(this.workflowPath)},
      symbols:{file:'symbols.ndjson',sha256:fileSha(this.symbolsPath)},
      control:{file:'control.phasebin',sha256:control.sha256,records:control.records,bytes:control.bytes},
      signals:{file:'signals.phasebin',sha256:signals.sha256,records:signals.records,bytes:signals.bytes},
      state:{file:'state.phasebin',sha256:state.sha256,records:state.records,bytes:state.bytes}
    };
    const manifest={schema:'phase-research-run-v2',run_id:this.id,experiment:this.experiment,started_at:this.startedAt,ended_at:new Date().toISOString(),phase_seed_sha256:this.seedSha,workflow_sha256:workflowHash(this.workflow),workflow_id:this.workflow.id,node:process.version,platform:process.platform,arch:process.arch,git:gitSnapshot(this.workflow.cwd),protocol:{isa:'phase-isa-v1',packet:'phasebin-v1',signals:'phase-genuine-signals-v2',workflow:'phase-workflow-v1'},canonical,derived:{events:{file:'events.ndjson',sha256:fileSha(this.events),event_chain_head:this.prevHash,event_count:this.count}},summary};
    const manifestPath=join(this.dir,'manifest.json');writeFileSync(manifestPath,JSON.stringify(manifest,null,2));const seal=sha(readFileSync(manifestPath));writeFileSync(join(this.dir,'SEALED'),`${seal}  manifest.json\n`);
    const result={schema:'phase-run-result-v1',passed:Boolean(summary.passed),run_id:this.id,workflow_id:this.workflow.id,wall_ms:Number(summary.wall_ms??0),fibers:Number(summary.fibers??0),completed:Number(summary.completed??0),failed:Number(summary.failed??0),manifest_sha256:seal,canonical};writeFileSync(join(this.dir,'result.json'),JSON.stringify(result,null,2));
    return manifest;
  }
}

export function verifyResearchEventLog(path){const lines=readFileSync(path,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);let prev='0'.repeat(64);const failures=[];for(const row of lines){const {sha256:got,...body}=row;if(body.prev_sha256!==prev)failures.push({seq:row.seq,type:'previous-hash',expected:prev,got:body.prev_sha256});const expected=sha(body);if(expected!==got)failures.push({seq:row.seq,type:'event-hash',expected,got});prev=got;}return{passed:failures.length===0,events:lines.length,head:prev,failures};}

export function verifyResearchRun(dir){
  dir=resolve(dir);const failures=[];const manifestPath=join(dir,'manifest.json');const sealPath=join(dir,'SEALED');if(!existsSync(manifestPath))return{passed:false,dir,failures:['missing manifest.json']};
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));const actualSeal=sha(readFileSync(manifestPath));if(!existsSync(sealPath))failures.push('missing SEALED');else{const expected=readFileSync(sealPath,'utf8').trim().split(/\s+/)[0];if(expected!==actualSeal)failures.push('manifest seal mismatch');}
  for(const [name,meta] of Object.entries(manifest.canonical??{})){const p=join(dir,meta.file);if(!existsSync(p)){failures.push(`missing canonical ${name}: ${meta.file}`);continue;}if(fileSha(p)!==meta.sha256)failures.push(`canonical hash mismatch: ${meta.file}`);if(meta.file.endsWith('.phasebin')){const v=verifyPhaseBin(p);if(!v.passed)failures.push(...v.failures.map(x=>`${meta.file}: ${x}`));}}
  const e=manifest.derived?.events;if(e){const p=join(dir,e.file);if(!existsSync(p))failures.push(`missing derived ${e.file}`);else{if(fileSha(p)!==e.sha256)failures.push(`derived hash mismatch: ${e.file}`);const v=verifyResearchEventLog(p);if(!v.passed)failures.push(...v.failures.map(x=>`${e.file}: ${JSON.stringify(x)}`));}}
  return{passed:failures.length===0,dir,run_id:manifest.run_id,workflow_id:manifest.workflow_id,manifest_sha256:actualSeal,canonical:manifest.canonical,failures};
}

export function wilson(success,total,z=1.96){if(!total)return{low:0,high:0};const p=success/total,den=1+z*z/total,mid=(p+z*z/(2*total))/den,margin=z*Math.sqrt((p*(1-p)+z*z/(4*total))/total)/den;return{low:mid-margin,high:mid+margin};}
export function summarizeExperiment(results){const n=results.length,success=results.filter(x=>x.passed).length,wall=results.map(x=>Number(x.wall_ms??0));return{schema:'phase-experiment-summary-v2',n,success,pass_rate:n?success/n:0,pass_rate_95ci:wilson(success,n),wall_ms:{mean:n?wall.reduce((a,b)=>a+b,0)/n:0,min:n?Math.min(...wall):0,max:n?Math.max(...wall):0}};}
