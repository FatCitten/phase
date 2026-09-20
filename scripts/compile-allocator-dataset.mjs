#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PHASE_ARCHITECTURE_SEED, seedExamples, seedHash, seedSystemPrompt } from '../src/phase-seeds.mjs';
import { sha256 } from '../src/util.mjs';
import { defaultAllocationObjective } from '../src/signals.mjs';

function walk(p,out=[]){if(!existsSync(p))return out;const st=statSync(p);if(st.isFile()){if(p.endsWith('events.ndjson'))out.push(p);return out;}for(const x of readdirSync(p))walk(join(p,x),out);return out;}
function readLines(p){return readFileSync(p,'utf8').split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));}
function jsonl(rows){return rows.map(JSON.stringify).join('\n')+(rows.length?'\n':'');}

const root=resolve(process.argv[2]??'.phase/experiments');const out=resolve(process.argv[3]??'phase-allocator-dataset');mkdirSync(out,{recursive:true});
const rows=[...seedExamples()];let runExamples=0;
for(const file of walk(root)){
  const events=readLines(file), allocations=new Map();
  for(const e of events){if(e.type==='fiber.allocated')allocations.set(e.payload.fiber_id,e.payload.allocation);if(e.type==='fiber.completed'){
    const a=allocations.get(e.payload.fiber_id);if(!a)continue;const signals=e.payload.signals??null;
    rows.push({schema:'phase-allocation-example-v1',source:'measured-run',state_vector:a.state_vector,target:{agent:a.agent,tools:a.tools,budget:a.budget,stop:a.stop},signals,outcome:{passed:Boolean(e.payload.passed),wall_ms:Number(e.payload.wall_ms??0),objective:signals?defaultAllocationObjective(signals):null}});runExamples++;
  }}
}
const dataPath=join(out,'allocator.jsonl');writeFileSync(dataPath,jsonl(rows));
const chat=rows.map((x,i)=>({id:`alloc-${i+1}`,messages:[{role:'system',content:seedSystemPrompt()},{role:'user',content:JSON.stringify({state_vector:x.state_vector??x.state,target_constraints:x.outcome??null})},{role:'assistant',content:JSON.stringify(x.target)}]}));
const chatPath=join(out,'allocator-chat.jsonl');writeFileSync(chatPath,jsonl(chat));
const manifest={schema:'phase-allocator-dataset-v1',root,architecture_seed_sha256:seedHash(PHASE_ARCHITECTURE_SEED),seed_examples:seedExamples().length,measured_examples:runExamples,total_examples:rows.length,files:{dataset:dataPath,chat:chatPath},hashes:{dataset:sha256(readFileSync(dataPath)),chat:sha256(readFileSync(chatPath))}};writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest,null,2));
