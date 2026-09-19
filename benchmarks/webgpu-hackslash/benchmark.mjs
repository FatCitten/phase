#!/usr/bin/env node
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runHarness } from '../../src/harness-runner.mjs';
import { startPhaseCloudServer } from '../../src/cloud-server.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const root=mkdtempSync(join(tmpdir(),'phase-webgpu-bench-'));
const task='Build a browser-based first-person raycasted hack-and-slash using WebGPU/WGSL. It must have grid raycast walls, WASD movement, pointer-lock mouse look, enemies, melee damage, HUD, and no third-party runtime dependencies.';
const fixture=resolve(here,'fixture-agent.mjs'), validator=resolve(here,'validate.mjs');
function starter(dir){
  mkdirSync(join(dir,'src'),{recursive:true});
  writeFileSync(join(dir,'index.html'),'<!doctype html><title>starter</title>\n');
  writeFileSync(join(dir,'src/game.js'),"console.log('starter');\n");
  writeFileSync(join(dir,'src/shader.wgsl'),'// starter\n');
  execFileSync('git',['init','-q'],{cwd:dir});execFileSync('git',['config','user.email','phase@example.invalid'],{cwd:dir});execFileSync('git',['config','user.name','Phase Benchmark'],{cwd:dir});execFileSync('git',['add','.'],{cwd:dir});execFileSync('git',['commit','-qm','starter'],{cwd:dir});
}
function validate(cwd){const r=spawnSync(process.execPath,[validator],{cwd,encoding:'utf8'});return{status:r.status??1,stdout:r.stdout,stderr:r.stderr};}

const directDir=join(root,'direct');mkdirSync(directDir);starter(directDir);
const d0=performance.now();const directAgent=spawnSync(process.execPath,[fixture],{cwd:directDir,input:task,encoding:'utf8'});const directValidation=validate(directDir);const directMs=performance.now()-d0;

const phaseDir=join(root,'phase');mkdirSync(phaseDir);starter(phaseDir);
const privateLog=join(root,'cloud-private.ndjson'),productLog=join(root,'cloud-product.ndjson');
const cloud=await startPhaseCloudServer({apiKeys:{'bench-key':{account:'benchmark',premium:true}},privateLog,productLog});
const configPath=join(root,'phase-task.json');
writeFileSync(configPath,JSON.stringify({
  id:'webgpu-hackslash-benchmark',cwd:phaseDir,task,
  worker:{adapter:'exec',argv:[process.execPath,fixture],prompt:'stdin'},
  verify:{public:[[process.execPath,validator]]},
  isolation:{enabled:false,required:false},
  governor:{policy:'heuristic',max_repairs:2,max_steps:10},
  cloud:{enabled:true,url:cloud.url,api_key:'bench-key',telemetry:'metrics',data_product:'aggregate',timeout_ms:2000},
  training:{enabled:true},report:{enabled:true,title:'WebGPU Hack-and-Slash Phase Benchmark'},tags:['benchmark','webgpu','game']
},null,2));
const phaseResult=await runHarness(configPath);
await cloud.close();
const phaseValidation=validate(phaseDir);

const report={schema:'phase-webgpu-benchmark-v1',task,syntheticWorker:true,limitation:'The worker is a deterministic deliberately-fallible fixture, not an LLM. This verifies Phase orchestration/repair and artifact acceptance, not general model quality.',direct:{agentExit:directAgent.status??1,validationStatus:directValidation.status,passed:directValidation.status===0,wallTimeMs:directMs,validationOutput:directValidation.stdout+directValidation.stderr},phase:{passed:phaseResult.passed,validationStatus:phaseValidation.status,workerRuns:phaseResult.controller?.state?.workerRuns??0,repairs:phaseResult.controller?.state?.repairs??0,wallTimeMs:phaseResult.wallTimeMs,cloud:phaseResult.cloud,behaviors:(phaseResult.controller?.trace??[]).map(x=>x.behavior),resultPath:phaseResult.resultPath,validationOutput:phaseValidation.stdout+phaseValidation.stderr},comparison:{phaseRecoveredAcceptanceFailure:directValidation.status!==0&&phaseResult.passed,manualRepairNeededWithoutPhase:directValidation.status!==0,automaticRepairWithPhase:(phaseResult.controller?.state?.repairs??0)>0&&phaseResult.passed},cloudProductRecords:readFileSync(productLog,'utf8').trim().split('\n').filter(Boolean).length};
const outDir=resolve(here,'../../results/webgpu-hackslash-benchmark');mkdirSync(outDir,{recursive:true});writeFileSync(join(outDir,'result.json'),JSON.stringify(report,null,2));writeFileSync(join(outDir,'product-sample.ndjson'),readFileSync(productLog,'utf8'));
const demo=resolve(here,'../../examples/webgpu-hackslash');rmSync(demo,{recursive:true,force:true});mkdirSync(demo,{recursive:true});for(const rel of ['index.html','src'])cpSync(join(phaseDir,rel),join(demo,rel),{recursive:true});
writeFileSync(join(demo,'README.md'),`# Phaseblade\n\nWebGPU raycast hack-and-slash artifact produced by the Phase benchmark. Serve this directory over localhost or HTTPS, then click the canvas.\n\nControls: WASD, mouse look, click to slash.\n`);
console.log(JSON.stringify(report,null,2));
