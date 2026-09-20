import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { verifyResearchRun } from './research.mjs';
import { readPhaseBin } from './phasebin.mjs';
import { OPCODE, RESOURCE, opcodeLabel, resourceLabel } from './isa.mjs';

const sha=(x)=>createHash('sha256').update(Buffer.isBuffer(x)?x:String(x)).digest('hex');
const fileSha=(p)=>sha(readFileSync(p));
function walkManifests(p,out=[]){if(!existsSync(p))return out;const s=statSync(p);if(s.isFile()){if(basename(p)==='manifest.json'&&existsSync(join(dirname(p),'SEALED')))out.push(p);return out;}for(const n of readdirSync(p))walkManifests(join(p,n),out);return out;}
function readSymbols(path){const byKind={};for(const line of readFileSync(path,'utf8').split(/\r?\n/).filter(Boolean)){const x=JSON.parse(line);(byKind[x.kind]??={})[String(x.id)]=x;}return byKind;}

export function deriveAllocationEpisodes(runDir){
  runDir=resolve(runDir);const verification=verifyResearchRun(runDir);if(!verification.passed)throw new Error(`invalid research run ${runDir}: ${verification.failures.join('; ')}`);
  const manifest=JSON.parse(readFileSync(join(runDir,'manifest.json'),'utf8'));const symbols=readSymbols(join(runDir,'symbols.ndjson'));const control=readPhaseBin(join(runDir,'control.phasebin')).packets;const signals=readPhaseBin(join(runDir,'signals.phasebin')).packets;const state=readPhaseBin(join(runDir,'state.phasebin')).packets;
  const ids=new Set([...control,...signals,...state].map(x=>x.fiber).filter(Boolean));const out=[];
  for(const fid of [...ids].sort((a,b)=>a-b)){
    const cp=control.filter(x=>x.fiber===fid),sp=signals.filter(x=>x.fiber===fid),st=state.filter(x=>x.fiber===fid);if(!cp.some(x=>x.opcode===OPCODE.FORK))continue;
    const budget={};for(const p of cp.filter(x=>x.opcode===OPCODE.ALLOC))budget[resourceLabel(p.a).toLowerCase()]=Number(p.value);
    const route=cp.find(x=>x.opcode===OPCODE.ROUTE);const grants=cp.filter(x=>x.opcode===OPCODE.GRANT).map(x=>symbols.tool?.[String(x.a)]?.label??`0x${x.a.toString(16)}`);
    const dimensions=Number(st.find(x=>x.opcode===OPCODE.STATE_FEATURE)?.b??0);const vector=Array(dimensions).fill(0);for(const p of st.filter(x=>x.opcode===OPCODE.STATE_FEATURE))if(p.a<vector.length)vector[p.a]=Number(p.value)/1e6;
    const repo=st.find(x=>x.opcode===OPCODE.STATE_REPO);const validPass=sp.some(x=>x.opcode===OPCODE.SIG_VALID_PASS),validFail=sp.some(x=>x.opcode===OPCODE.SIG_VALID_FAIL);const wall=sp.find(x=>x.opcode===OPCODE.SIG_WALL_MS);
    const rawControl=cp.filter(x=>[OPCODE.ROUTE,OPCODE.ALLOC,OPCODE.GRANT].includes(x.opcode)).map(x=>({op:opcodeLabel(x.opcode),flags:x.flags,a:x.a,b:x.b,value:Number(x.value)}));
    out.push({schema:'phase-allocation-episode-v1',source_manifest_sha256:verification.manifest_sha256,run_id:manifest.run_id,workflow_id:manifest.workflow_id,fiber:{number:fid,id:symbols.fiber?.[String(fid)]?.label??`F${fid}`},state:{schema:'phase-state-vector-v1',dimensions,repository:symbols.repository?.[String(repo?.a)]?.label??(repo?`0x${repo.a.toString(16)}`:null),vector},allocation:{agent:route?(symbols.agent?.[String(route.a)]?.label??`0x${route.a.toString(16)}`):null,tools:grants,budget},control_isa:rawControl,measurements:{validation_passed:validPass?1:(validFail?0:null),wall_ms:wall?Number(wall.value):null}});
  }
  return out;
}

export function buildCorpus({experimentsDir,outDir,strict=true}={}){
  const root=resolve(experimentsDir);const out=resolve(outDir);mkdirSync(out,{recursive:true});const manifests=walkManifests(root).sort();const runs=[];const bad=[];const seen=new Set();
  for(const mp of manifests){const dir=dirname(mp),v=verifyResearchRun(dir);if(!v.passed){bad.push({dir,failures:v.failures});continue;}if(seen.has(v.manifest_sha256))continue;seen.add(v.manifest_sha256);const m=JSON.parse(readFileSync(mp,'utf8'));runs.push({run_id:m.run_id,workflow_id:m.workflow_id,source_rel:relative(root,dir)||'.',manifest_sha256:v.manifest_sha256,phase_seed_sha256:m.phase_seed_sha256,workflow_sha256:m.workflow_sha256,canonical:m.canonical,summary:{passed:Boolean(m.summary?.passed),wall_ms:Number(m.summary?.wall_ms??0),fibers:Number(m.summary?.fibers??0)}});}
  if(strict&&bad.length)throw new Error(`corrupt/unsealed research runs rejected: ${JSON.stringify(bad)}`);
  const runsPath=join(out,'runs.ndjson');writeFileSync(runsPath,runs.map(JSON.stringify).join('\n')+(runs.length?'\n':''));const episodes=runs.flatMap(r=>deriveAllocationEpisodes(resolve(root,r.source_rel)));const episodesPath=join(out,'allocation-episodes.ndjson');writeFileSync(episodesPath,episodes.map(JSON.stringify).join('\n')+(episodes.length?'\n':''));
  const manifest={schema:'phase-corpus-v1',created_at:new Date().toISOString(),source_root:root,runs:runs.length,episodes:episodes.length,rejected:bad.length,files:{runs:{file:'runs.ndjson',sha256:fileSha(runsPath)},allocation_episodes:{file:'allocation-episodes.ndjson',sha256:fileSha(episodesPath)}},principle:'canonical run buses are immutable measurements; corpus views are derived indexes'};const manifestPath=join(out,'corpus.json');writeFileSync(manifestPath,JSON.stringify(manifest,null,2));const seal=sha(readFileSync(manifestPath));writeFileSync(join(out,'SEALED'),`${seal}  corpus.json\n`);return{...manifest,seal_sha256:seal,bad};
}

export function verifyCorpus(dir){dir=resolve(dir);const failures=[];const mpath=join(dir,'corpus.json'),sealPath=join(dir,'SEALED');if(!existsSync(mpath))return{passed:false,failures:['missing corpus.json']};const m=JSON.parse(readFileSync(mpath,'utf8')),got=sha(readFileSync(mpath));if(!existsSync(sealPath))failures.push('missing SEALED');else if(readFileSync(sealPath,'utf8').trim().split(/\s+/)[0]!==got)failures.push('corpus seal mismatch');for(const meta of Object.values(m.files??{})){const p=join(dir,meta.file);if(!existsSync(p))failures.push(`missing ${meta.file}`);else if(fileSha(p)!==meta.sha256)failures.push(`hash mismatch ${meta.file}`);}return{passed:failures.length===0,dir,corpus_sha256:got,runs:m.runs,episodes:m.episodes,failures};}
