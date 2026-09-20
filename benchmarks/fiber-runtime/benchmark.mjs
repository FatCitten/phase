import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWorkflow } from '../../src/phase-ir.mjs';
import { runWorkflow } from '../../src/fiber-runtime.mjs';
import { FiberRenderer } from '../../src/fiber-ui.mjs';
import { verifyResearchEventLog } from '../../src/research.mjs';

const here=dirname(fileURLToPath(import.meta.url));const root=mkdtempSync(join(tmpdir(),'phase-fiber-bench-'));mkdirSync(join(root,'bin'),{recursive:true});const agent=join(root,'bin','fixture-agent.mjs');copyFileSync(join(here,'fixture-agent.mjs'),agent);
const spec={adapter:'exec',argv:[process.execPath,agent],prompt:'stdin'};
const wf=normalizeWorkflow({id:'fiber-runtime-benchmark',cwd:root,objective:'Build and integrate a two-stage validated artifact',isolation:{enabled:false},fibers:[
  {id:'F1',objective:'Create the validated foundation artifact',agent:spec,tools:['write','test'],validation:["grep -q '^foundation$' artifact.txt"]},
  {id:'F2',objective:'Integrate the second stage without losing the foundation',depends_on:['F1'],agent:spec,tools:['read','write','test'],validation:["grep -q '^foundation$' artifact.txt && grep -q '^integration$' artifact.txt"]}
]});
const r=await runWorkflow(wf,{renderer:new FiberRenderer({enabled:false}),experiment:'v0.9-fiber-runtime'});const integrity=verifyResearchEventLog(join(r.run_dir,'events.ndjson'));const result={schema:'phase-fiber-runtime-benchmark-v1',passed:r.passed,fibers:r.fibers,completed:r.completed,failed:r.failed,wall_ms:r.wall_ms,event_log_integrity:integrity,research_artifacts:['manifest.json','events.ndjson','result.json']};
const out=resolve('results/v09-fiber-runtime-benchmark.json');writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(!r.passed||!integrity.passed)process.exitCode=2;
