import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { seedHash, PHASE_ARCHITECTURE_SEED } from './phase-seeds.mjs';
import { workflowHash } from './phase-ir.mjs';
import { gitSnapshot, stableJson } from './util.mjs';

const sha=(x)=>createHash('sha256').update(typeof x==='string'?x:stableJson(x)).digest('hex');
export class ResearchRun {
  constructor({ workflow, outDir, seed = PHASE_ARCHITECTURE_SEED, experiment = null }) {
    this.id=randomUUID(); this.workflow=workflow; this.dir=resolve(outDir); this.events=resolve(this.dir,'events.ndjson');this.prevHash='0'.repeat(64);mkdirSync(this.dir,{recursive:true});
    this.manifest={schema:'phase-experiment-v1',run_id:this.id,experiment,started_at:new Date().toISOString(),phase_seed_sha256:seedHash(seed),workflow_sha256:workflowHash(workflow),workflow_id:workflow.id,node:process.version,platform:process.platform,arch:process.arch,git:gitSnapshot(workflow.cwd),protocol:{events:'phase-research-event-v1',allocation:'phase-allocation-v1',state_vector:'phase-state-vector-v1'}};
    writeFileSync(resolve(this.dir,'manifest.json'),JSON.stringify(this.manifest,null,2));
  }
  event(type,payload={}){
    const body={schema:'phase-research-event-v1',run_id:this.id,seq:this.count=(this.count??0)+1,at:new Date().toISOString(),mono_ms:Number(performance.now().toFixed(3)),type,payload,prev_sha256:this.prevHash};
    const row={...body,sha256:sha(body)};this.prevHash=row.sha256;appendFileSync(this.events,JSON.stringify(row)+'\n');return row;
  }
  finish(summary){const final={...this.manifest,ended_at:new Date().toISOString(),summary,event_count:this.count??0,event_chain_head:this.prevHash,event_log_sha256:sha(readFileSync(this.events))};writeFileSync(resolve(this.dir,'result.json'),JSON.stringify(final,null,2));return final;}
}

export function verifyResearchEventLog(path){const lines=readFileSync(path,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);let prev='0'.repeat(64);const failures=[];for(const row of lines){const {sha256:got,...body}=row;if(body.prev_sha256!==prev)failures.push({seq:row.seq,type:'previous-hash',expected:prev,got:body.prev_sha256});const expected=sha(body);if(expected!==got)failures.push({seq:row.seq,type:'event-hash',expected,got});prev=got;}return{passed:failures.length===0,events:lines.length,head:prev,failures};}
export function wilson(success,total,z=1.96){if(!total)return{low:0,high:0};const p=success/total,den=1+z*z/total,mid=(p+z*z/(2*total))/den,margin=z*Math.sqrt((p*(1-p)+z*z/(4*total))/total)/den;return{low:mid-margin,high:mid+margin};}
export function summarizeExperiment(results){const n=results.length,success=results.filter(x=>x.passed).length,wall=results.map(x=>Number(x.wall_ms??0));return{schema:'phase-experiment-summary-v1',n,success,pass_rate:n?success/n:0,pass_rate_95ci:wilson(success,n),wall_ms:{mean:n?wall.reduce((a,b)=>a+b,0)/n:0,min:n?Math.min(...wall):0,max:n?Math.max(...wall):0}};}
