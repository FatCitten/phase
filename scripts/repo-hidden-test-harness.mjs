#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BrainStore } from '../src/store.mjs';
import { PhaseAssociativeIndex, defaultPhaseIndexPath } from '../src/phase-index.mjs';
import { runRepoController } from '../src/repo-controller.mjs';
function hash(path){const h=createHash('sha256');h.update(readFileSync(path));return h.digest('hex');}
function run(argv,cwd){const r=spawnSync(argv[0],argv.slice(1),{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});return{argv,status:r.status??1,stdout:r.stdout??'',stderr:r.stderr??''};}
const configPath=process.argv[2]; if(!configPath){console.error('usage: node scripts/repo-hidden-test-harness.mjs task.json');process.exit(64);}
const cfgPath=resolve(configPath); const cfg=JSON.parse(readFileSync(cfgPath,'utf8')); const cwd=resolve(cfg.cwd??'.');
if((cfgPath.startsWith(cwd+'/')||cfgPath===cwd)&&cfg.allow_config_in_worktree!==true) throw new Error('benchmark config must live outside worktree');
for(const raw of cfg.hidden_paths??[]){const p=isAbsolute(raw)?raw:resolve(cwd,raw);if(existsSync(p))throw new Error(`hidden path already visible: ${p}`);}
const runId=cfg.id??`repo-${Date.now()}`; const phaseDir=resolve(cwd,'.phase','repo-benchmark',runId);mkdirSync(phaseDir,{recursive:true});
const dbPath=cfg.brain_db?resolve(cfg.brain_db):join(phaseDir,'brain.sqlite'); const indexPath=cfg.phase_index?resolve(cfg.phase_index):defaultPhaseIndexPath(dbPath);
process.env.PHASE_INDEX_PATH=indexPath;
if(cfg.public_validation_command) process.env.PHASE_VALIDATE_COMMAND=String(cfg.public_validation_command);
const result=await runRepoController({cwd,task:cfg.prompt,dbPath,cloudCommand:cfg.cloud_command??process.env.PHASE_CLOUD_COMMAND,policy:cfg.policy??'heuristic',maxSteps:Number(cfg.max_steps??12),maxRepairs:Number(cfg.max_repairs??2)});
const deny=[...(cfg.deny_patterns??[]),...(cfg.hidden_paths??[]),...(cfg.hidden_copies??[]).flatMap(x=>[x.from,x.to]),...(cfg.reference_paths??[])].filter(Boolean).map(String);
const brain=new BrainStore(dbPath);const provenance=brain.audit(deny);let indexAudit;try{const idx=PhaseAssociativeIndex.load(indexPath);idx.ensureSynced(brain);indexAudit=idx.audit(brain);}catch(e){indexAudit={passed:false,error:String(e)}}const ledgerHeadBeforeHidden=brain.ledgerHead();brain.close();
const audit={...provenance,index:indexAudit,passed:provenance.passed&&indexAudit.passed};
const protectedFiles=[dbPath,indexPath,...['-wal','-shm'].map(s=>dbPath+s)].filter(existsSync);const before=Object.fromEntries(protectedFiles.map(p=>[p,hash(p)]));for(const p of protectedFiles)chmodSync(p,0o444);
const installs=[];if(audit.passed&&result.success){for(const item of cfg.hidden_copies??[]){const from=resolve(item.from);const to=isAbsolute(item.to)?item.to:resolve(cwd,item.to);mkdirSync(dirname(to),{recursive:true});copyFileSync(from,to);installs.push({from,to});}}
const validations=[];if(audit.passed&&result.success){for(const command of cfg.hidden_validation_commands??cfg.validation_commands??[]){const argv=Array.isArray(command)?command:['bash','-lc',String(command)];const r=run(argv,cwd);validations.push(r);if(r.status!==0&&cfg.stop_on_failure!==false)break;}}
const after=Object.fromEntries(protectedFiles.map(p=>[p,hash(p)]));const frozen=JSON.stringify(before)===JSON.stringify(after);for(const p of protectedFiles){try{chmodSync(p,0o600)}catch{}}for(const item of installs.reverse()){try{rmSync(item.to,{recursive:true,force:true})}catch{}}for(const raw of cfg.hidden_paths??[]){try{rmSync(isAbsolute(raw)?raw:resolve(cwd,raw),{recursive:true,force:true})}catch{}}
const out={runId,cwd,sessionId:result.sessionId,ledgerHeadBeforeHidden,result,audit,frozenBeforeHiddenTests:frozen,validations,passed:result.success&&audit.passed&&frozen&&validations.every(v=>v.status===0)};
const resultPath=join(phaseDir,'result.json');writeFileSync(resultPath,JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));process.exitCode=out.passed?0:2;
