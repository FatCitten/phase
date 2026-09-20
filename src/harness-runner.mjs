import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BrainStore } from './store.mjs';
import { PhaseAssociativeIndex, defaultPhaseIndexPath } from './phase-index.mjs';
import { runRepoController } from './repo-controller.mjs';
import { loadHarnessConfig, publicValidationShell, validateHarnessBoundary } from './harness-config.mjs';
import { workerAdapterSummary } from './adapters.mjs';
import { writeRunReport } from './run-report.mjs';
import { exportRunTrainingData } from './training-export.mjs';
import { buildIsolationPlan, probeWorkerIsolation } from './worker-isolation.mjs';
import { PhaseCloudClient, aggregateRunResult, aggregateStep, taskFingerprint } from './cloud-sync.mjs';
import { repositoryDomainId } from './util.mjs';

function hash(path){const h=createHash('sha256');h.update(readFileSync(path));return h.digest('hex');}
function cmdLabel(c,i,scope){return `${scope} ${i+1}: ${Array.isArray(c)?c.join(' '):String(c)}`;}
function runCommand(command,cwd,label){const argv=Array.isArray(command)?command:['bash','-lc',String(command)];const t=performance.now();const r=spawnSync(argv[0],argv.slice(1),{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});return{label,argv,status:r.status??1,stdout:r.stdout??'',stderr:r.stderr??'',latencyMs:performance.now()-t};}
function pathInside(cwd,raw){return isAbsolute(raw)?raw:resolve(cwd,raw);}

export async function runHarness(configPath, { onStep = null } = {}) {
  const cfg=loadHarnessConfig(configPath);validateHarnessBoundary(cfg);
  const isolationProtected=[cfg.configPath,...cfg.hiddenCopies.map(x=>resolve(x.from)),...cfg.referencePaths.map(x=>resolve(x))];
  let isolationPreflight={available:true,backend:null,reason:null};
  if(cfg.isolationEnabled){
    isolationPreflight=probeWorkerIsolation();
    if(cfg.isolationRequired&&!isolationPreflight.available)throw new Error(`Phase hidden-evaluator isolation unavailable: ${isolationPreflight.reason}`);
    if(isolationPreflight.available)buildIsolationPlan({cwd:cfg.cwd,command:(cfg.worker.argv??[cfg.worker.command]).filter(Boolean).join(' '),readPaths:cfg.isolationReadPaths,copyPaths:cfg.isolationCopyPaths,protectedPaths:isolationProtected,env:{...process.env,...cfg.worker.env}});
  }
  for(const raw of cfg.hiddenPaths){const p=pathInside(cfg.cwd,raw);if(existsSync(p))throw new Error(`hidden evaluator path already visible before run: ${p}`);}
  for(const item of cfg.hiddenCopies){const to=pathInside(cfg.cwd,item.to);if(existsSync(to))throw new Error(`hidden install target already visible before run: ${to}`);}

  const runDir=resolve(cfg.cwd,'.phase','runs',cfg.id);mkdirSync(runDir,{recursive:true});
  const dbPath=cfg.brainDb??join(runDir,'brain.sqlite');
  const indexPath=cfg.phaseIndex??defaultPhaseIndexPath(dbPath);
  const oldIndex=process.env.PHASE_INDEX_PATH, oldValidate=process.env.PHASE_VALIDATE_COMMAND;
  process.env.PHASE_INDEX_PATH=indexPath;
  const publicShell=publicValidationShell(cfg);if(publicShell)process.env.PHASE_VALIDATE_COMMAND=publicShell;else delete process.env.PHASE_VALIDATE_COMMAND;
  const started=performance.now();
  const cloud=new PhaseCloudClient(cfg.cloud,{runId:cfg.id,repositoryId:repositoryDomainId(cfg.cwd),clientVersion:'0.9.0'});
  await cloud.connect();
  await cloud.emit('run.started',{runId:cfg.id,tags:cfg.tags,task:cfg.cloud.telemetry==='trace'?cfg.task:undefined,taskFingerprint:taskFingerprint(cfg.task),worker:workerAdapterSummary(cfg.worker),policy:cfg.policy},{workerAdapter:cfg.worker.id,policy:cfg.policy});
  let controller;
  try {
    controller=await runRepoController({cwd:cfg.cwd,task:cfg.task,dbPath,workerAdapter:cfg.worker,cloudCommand:cfg.worker.command,policy:cfg.policy,maxSteps:cfg.maxSteps,maxRepairs:cfg.maxRepairs,workerEnv:cfg.worker.env,workerIsolation:{enabled:cfg.isolationEnabled,required:cfg.isolationRequired,readPaths:cfg.isolationReadPaths,copyPaths:cfg.isolationCopyPaths,protectedPaths:isolationProtected},onStep:async(step)=>{await cloud.emit('controller.step',cfg.cloud.telemetry==='trace'?step:aggregateStep(step),aggregateStep(step));if(onStep)await onStep(step);}});
  } finally {
    if(oldIndex==null)delete process.env.PHASE_INDEX_PATH;else process.env.PHASE_INDEX_PATH=oldIndex;
    if(oldValidate==null)delete process.env.PHASE_VALIDATE_COMMAND;else process.env.PHASE_VALIDATE_COMMAND=oldValidate;
  }

  const publicValidation=cfg.publicCommands.length
    ? cfg.publicCommands.map((c,i)=>runCommand(c,cfg.cwd,cmdLabel(c,i,'Public')))
    : controller.state?.lastValidation ? [{label:'Public: controller validation',...controller.state.lastValidation,latencyMs:null}] : [];

  const deny=[...cfg.denyPatterns,...cfg.hiddenPaths,...cfg.hiddenCopies.flatMap(x=>[x.from,x.to]),...cfg.referencePaths].filter(Boolean).map(String);
  const brain=new BrainStore(dbPath);const provenance=brain.audit(deny);let indexAudit;
  try{const idx=PhaseAssociativeIndex.load(indexPath);idx.ensureSynced(brain);indexAudit=idx.audit(brain);}catch(e){indexAudit={passed:false,error:String(e)}}
  const ledgerHeadBeforeHidden=brain.ledgerHead();brain.close();
  const audit={...provenance,index:indexAudit,passed:provenance.passed&&indexAudit.passed};

  const protectedFiles=[dbPath,indexPath,...['-wal','-shm'].map(s=>dbPath+s)].filter(existsSync);
  const before=Object.fromEntries(protectedFiles.map(p=>[p,hash(p)]));
  for(const p of protectedFiles)chmodSync(p,0o444);
  const installs=[];const hiddenValidation=[];
  if(audit.passed&&controller.success&&publicValidation.every(x=>x.status===0)){
    for(const item of cfg.hiddenCopies){const from=resolve(item.from);const to=pathInside(cfg.cwd,item.to);mkdirSync(dirname(to),{recursive:true});copyFileSync(from,to);installs.push({from,to});}
    for(let i=0;i<cfg.hiddenCommands.length;i++){
      const c=cfg.hiddenCommands[i],r=runCommand(c,cfg.cwd,cmdLabel(c,i,'Hidden'));hiddenValidation.push(r);if(r.status!==0&&cfg.stopOnFailure)break;
    }
  }
  const after=Object.fromEntries(protectedFiles.map(p=>[p,hash(p)]));
  const brainFrozen=JSON.stringify(before)===JSON.stringify(after);
  for(const p of protectedFiles){try{chmodSync(p,0o600)}catch{}}
  for(const item of installs.reverse()){try{rmSync(item.to,{recursive:true,force:true})}catch{}}
  for(const raw of cfg.hiddenPaths){try{rmSync(pathInside(cfg.cwd,raw),{recursive:true,force:true})}catch{}}

  const publicPass=publicValidation.every(x=>x.status===0);
  const hiddenPass=hiddenValidation.length===cfg.hiddenCommands.length&&hiddenValidation.every(x=>x.status===0);
  const passed=Boolean(controller.success&&publicPass&&audit.passed&&brainFrozen&&hiddenPass);
  const result={schema:'phase-harness-run-v1',runId:cfg.id,task:cfg.task,cwd:cfg.cwd,tags:cfg.tags,worker:workerAdapterSummary(cfg.worker),policy:cfg.policy,brainDb:dbPath,phaseIndex:indexPath,controller,publicValidation,hiddenValidation,ledgerHeadBeforeHidden,audit,firewall:{configOutsideWorktree:!(cfg.configPath===cfg.cwd||cfg.configPath.startsWith(`${cfg.cwd}/`)),hiddenAssetsInstalled:cfg.hiddenCopies.length,hiddenCommands:cfg.hiddenCommands.length,brainFrozen,auditPassed:audit.passed,osIsolation:{enabled:cfg.isolationEnabled,required:cfg.isolationRequired,available:isolationPreflight.available,backend:isolationPreflight.backend,failClosed:cfg.isolationRequired}},wallTimeMs:performance.now()-started,passed};
  await cloud.emit('run.completed',cfg.cloud.telemetry==='trace'?result:aggregateRunResult(result),aggregateRunResult(result));
  const cloudSummary=cloud.summary();
  await cloud.close();
  result.cloud=cloudSummary;
  const resultPath=join(runDir,'result.json');writeFileSync(resultPath,JSON.stringify(result,null,2));
  let training=null;if(cfg.trainingEnabled)training=exportRunTrainingData({runResult:result,runDir,includePrivate:cfg.exportFullTrace});
  const reportPath=join(runDir,'report.html');if(cfg.reportEnabled)writeRunReport({...result,training},reportPath,{title:cfg.reportTitle});
  const final={...result,resultPath,reportPath:cfg.reportEnabled?reportPath:null,training};writeFileSync(resultPath,JSON.stringify(final,null,2));
  return final;
}
