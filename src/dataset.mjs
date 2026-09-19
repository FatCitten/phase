import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from './util.mjs';

function readJsonl(path){if(!existsSync(path))return[];return readFileSync(path,'utf8').split('\n').filter(Boolean).map(JSON.parse);}
function jsonl(rows){return rows.map(x=>JSON.stringify(x)).join('\n')+(rows.length?'\n':'');}
export function buildDataset({runsDir,outDir,acceptedOnly=true,portable=false}={}){
  const root=resolve(runsDir),out=resolve(outDir);mkdirSync(out,{recursive:true});
  const behavior=[],outcomes=[],runs=[];const seen=new Set();
  if(existsSync(root)) for(const id of readdirSync(root)){
    const resultPath=join(root,id,'result.json');if(!existsSync(resultPath))continue;
    let result;try{result=JSON.parse(readFileSync(resultPath,'utf8'));}catch{continue;}
    if(acceptedOnly&&!result.passed)continue;
    const bpath=join(root,id,'training','accepted.repo-behavior.jsonl');
    for(const row0 of readJsonl(bpath)){const key=`${id}:${row0.id}`;if(seen.has(key))continue;seen.add(key);const row={...row0,runId:id};if(portable&&row.state?.task){row.state={...row.state,taskHash:sha256(row.state.task),task:'[redacted portable corpus]'};}behavior.push(row);}
    outcomes.push(...readJsonl(join(root,id,'training','outcome.jsonl')));
    runs.push({runId:id,passed:Boolean(result.passed),worker:result.worker?.id??'unknown',model:result.worker?.model??null,steps:result.controller?.trace?.length??0,cloudCalls:(result.controller?.trace??[]).filter(x=>['delegate','repair'].includes(x.behavior)).length,repairs:(result.controller?.trace??[]).filter(x=>x.behavior==='repair').length,hiddenChecks:result.hiddenValidation?.length??0});
  }
  const behaviorPath=join(out,'phase.repo-behavior.jsonl'),outcomePath=join(out,'phase.outcomes.jsonl');writeFileSync(behaviorPath,jsonl(behavior));writeFileSync(outcomePath,jsonl(outcomes));
  const behaviorCounts={};for(const x of behavior){const k=x.target?.behavior??'unknown';behaviorCounts[k]=(behaviorCounts[k]??0)+1;}
  const workers={};for(const x of runs){workers[x.worker]=(workers[x.worker]??0)+1;}
  const manifest={schema:'phase-corpus-v1',generatedAt:new Date().toISOString(),runsDir:root,acceptedOnly,portable,runs:runs.length,behaviorExamples:behavior.length,outcomes:outcomes.length,behaviorCounts,workers,files:{behavior:behaviorPath,outcomes:outcomePath},hashes:{behavior:sha256(readFileSync(behaviorPath)),outcomes:sha256(readFileSync(outcomePath))},privacy:{containsBehaviorTargets:true,containsPatchTargets:false,containsHiddenTestBodies:false,privateFullTracesIncluded:false,taskText:portable?'redacted':'retained-local'}};
  writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2));return manifest;
}
