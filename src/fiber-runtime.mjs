import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PhaseAllocator } from './allocator.mjs';
import { FiberRenderer } from './fiber-ui.mjs';
import { ResearchRun } from './research.mjs';
import { resolveWorkerAdapter, detectAvailableAdapters } from './adapters.mjs';
import { runCloudWorker } from './cloud-worker.mjs';
import { computeFiberSignals } from './signals.mjs';

function runValidation(command,cwd){const argv=Array.isArray(command)?command:['bash','-lc',String(command)];const t=performance.now();const r=spawnSync(argv[0],argv.slice(1),{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});return{argv,status:r.status??1,stdout:r.stdout??'',stderr:r.stderr??'',wall_ms:performance.now()-t};}
function ready(f,status){return f.depends_on.every(d=>status.get(d)==='done');}
function prompt(workflow,fiber,allocation){return `You are an execution fiber in a Phase workflow. Do the assigned work directly; do not redesign the workflow.\n\nPROJECT OBJECTIVE\n${workflow.objective}\n\nFIBER ${fiber.id}\n${fiber.objective}\n\nPROJECT CONSTRAINTS\n${workflow.constraints.join('\n')||'(none)'}\n\nHUMAN DECISIONS\n${workflow.decisions.join('\n')||'(none)'}\n\nALLOCATED TOOLS\n${allocation.tools.join(', ')}\n\nBUDGET HINTS\ncontext=${allocation.budget.context_tokens} tokens; wall=${allocation.budget.wall_ms}ms; tool_calls=${allocation.budget.tool_calls}\n\nFinish this fiber only. Keep changes minimal and leave the repository in a testable state.`;}

export async function runWorkflow(workflow,{outDir=null,renderer=null,experiment=null}={}){
  const root=resolve(workflow.cwd); const runDir=resolve(outDir??join(root,'.phase','experiments',`${workflow.id}-${Date.now()}`));mkdirSync(runDir,{recursive:true});
  const research=new ResearchRun({workflow,outDir:runDir,experiment});const ui=renderer??new FiberRenderer();const allocator=new PhaseAllocator({policy:workflow.allocator?.policy??'heuristic',model:workflow.allocator});const status=new Map(workflow.fibers.map(f=>[f.id,'queued']));const outcomes=[];const available=detectAvailableAdapters();
  research.event('workflow.started',{workflow_id:workflow.id,fibers:workflow.fibers.map(x=>x.id)});
  try{
    while([...status.values()].some(x=>!['done','failed','blocked'].includes(x))){
      let progressed=false;
      for(const fiber of workflow.fibers){
        if(status.get(fiber.id)!=='queued')continue;
        if(fiber.depends_on.some(d=>['failed','blocked'].includes(status.get(d)))){status.set(fiber.id,'blocked');ui.update(fiber.id,{status:'blocked',label:fiber.objective,detail:'dependency failed'});research.event('fiber.blocked',{fiber_id:fiber.id});progressed=true;continue;}
        if(!ready(fiber,status))continue;
        progressed=true;status.set(fiber.id,'allocated');ui.update(fiber.id,{status:'allocated',label:fiber.objective,detail:'allocating'});
        const allocation=await allocator.allocate({workflow,fiber,runtime:{},availableAgents:available});research.event('fiber.allocated',{fiber_id:fiber.id,allocation});
        const adapter=resolveWorkerAdapter(allocation.agent_spec??{adapter:allocation.agent==='auto'?'auto':allocation.agent});
        ui.update(fiber.id,{status:'context',detail:`${adapter.id} · ${allocation.budget.context_tokens}ctx`});research.event('fiber.context',{fiber_id:fiber.id,state_vector:allocation.state_vector});
        ui.update(fiber.id,{status:'running',detail:`${adapter.id} working`});const started=performance.now();
        let worker;try{worker=await runCloudWorker({cwd:root,prompt:prompt(workflow,fiber,allocation),adapter,timeoutMs:Number(allocation.budget.wall_ms),isolation:{enabled:workflow.isolation?.enabled!==false,required:Boolean(workflow.isolation?.required),readPaths:(workflow.isolation?.read??[]).map(x=>resolve(root,x)),copyPaths:(workflow.isolation?.copy??[]).map(x=>resolve(root,x)),protectedPaths:[]}});}catch(e){worker={ok:false,error:String(e)};}
        research.event('fiber.worker',{fiber_id:fiber.id,ok:Boolean(worker.ok),wall_ms:performance.now()-started,adapter:adapter.id});
        ui.update(fiber.id,{status:'validating',detail:`${fiber.validation.length} check(s)`});const checks=fiber.validation.map(v=>runValidation(v,root));const passed=Boolean(worker.ok)&&checks.every(x=>x.status===0);
        status.set(fiber.id,passed?'done':'failed');const outcome={fiber_id:fiber.id,passed,worker_ok:Boolean(worker.ok),validation:checks,wall_ms:performance.now()-started,allocation};outcome.signals=computeFiberSignals(outcome);outcomes.push(outcome);research.event('fiber.completed',outcome);
        ui.update(fiber.id,{status:passed?'done':'failed',label:fiber.objective,detail:passed?'validated':'failed'});
      }
      if(!progressed)throw new Error('workflow deadlock: unresolved dependency cycle or blocked fibers');
    }
    const passed=outcomes.length===workflow.fibers.length&&outcomes.every(x=>x.passed);const summary={passed,fibers:outcomes.length,completed:outcomes.filter(x=>x.passed).length,failed:outcomes.filter(x=>!x.passed).length,wall_ms:outcomes.reduce((s,x)=>s+x.wall_ms,0),outcomes};return{...summary,run_dir:runDir,research:research.finish(summary)};
  }finally{ui.close();}
}
