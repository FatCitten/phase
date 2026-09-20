import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWorkflow } from '../../src/phase-ir.mjs';
import { runWorkflow } from '../../src/fiber-runtime.mjs';
import { FiberRenderer } from '../../src/fiber-ui.mjs';
import { verifyResearchRun } from '../../src/research.mjs';
import { buildCorpus, verifyCorpus } from '../../src/corpus.mjs';

const here=dirname(fileURLToPath(import.meta.url));const root=mkdtempSync(join(tmpdir(),'phase-v1-bench-'));mkdirSync(join(root,'bin'),{recursive:true});const agent=join(root,'bin','fixture-agent.mjs');copyFileSync(join(here,'fixture-agent.mjs'),agent);const spec={adapter:'exec',argv:[process.execPath,agent],prompt:'stdin'};
const wf=normalizeWorkflow({id:'v1-fiber-benchmark',cwd:root,objective:'Build and integrate a two-stage validated artifact',isolation:{enabled:false},fibers:[
  {id:'F1',objective:'Create the validated foundation artifact',agent:spec,tools:['write','test'],validation:["grep -q '^foundation$' artifact.txt"]},
  {id:'F2',objective:'Integrate the second stage without losing the foundation',depends_on:['F1'],agent:spec,tools:['read','write','test'],validation:["grep -q '^foundation$' artifact.txt && grep -q '^integration$' artifact.txt"]}
]});
const r=await runWorkflow(wf,{renderer:new FiberRenderer({enabled:false}),experiment:'phase-v1-fiber-runtime'});const runIntegrity=verifyResearchRun(r.run_dir);const corpusDir=join(root,'corpus');const corpus=buildCorpus({experimentsDir:join(root,'.phase','experiments'),outDir:corpusDir});const corpusIntegrity=verifyCorpus(corpusDir);const result={schema:'phase-v1-benchmark',passed:r.passed&&runIntegrity.passed&&corpusIntegrity.passed&&corpus.episodes===2,fibers:r.fibers,completed:r.completed,canonical_records:{control:r.research.canonical.control.records,signals:r.research.canonical.signals.records,state:r.research.canonical.state.records},run_integrity:runIntegrity.passed,corpus_integrity:corpusIntegrity.passed,allocation_episodes:corpus.episodes};console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=2;
