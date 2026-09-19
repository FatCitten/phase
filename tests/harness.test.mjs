import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runHarness } from '../src/harness-runner.mjs';
import { loadHarnessConfig, validateHarnessBoundary } from '../src/harness-config.mjs';
import { startDashboard } from '../src/dashboard-server.mjs';
import { probeWorkerIsolation } from '../src/worker-isolation.mjs';

function sh(cwd,...args){return execFileSync(args[0],args.slice(1),{cwd,encoding:'utf8'});}
function initRepo(dir){
  sh(dir,'git','init','-q');sh(dir,'git','config','user.email','test@example.com');sh(dir,'git','config','user.name','Test');
  writeFileSync(join(dir,'app.txt'),'wrong\n');
  writeFileSync(join(dir,'public_check.py'),"from pathlib import Path\nassert Path('app.txt').read_text() == 'right\\n'\n");
  sh(dir,'git','add','.');sh(dir,'git','commit','-qm','init');
}

test('v0.7 generic argv harness OS-isolates hidden evaluator and produces visual/training artifacts', async (t) => {
  const probe=probeWorkerIsolation(); if(!probe.available){t.skip(`OS isolation unavailable: ${probe.reason}`);return;}
  const root=mkdtempSync(join(tmpdir(),'phase-harness-v05-'));const repo=join(root,'repo');const operator=join(root,'operator');mkdirSync(repo);mkdirSync(operator);initRepo(repo);
  const hiddenSource=join(operator,'hidden_check.py');
  writeFileSync(hiddenSource,"from pathlib import Path\nassert Path('app.txt').read_text() == 'right\\n'\nassert Path('worker-saw-hidden.txt').read_text() == 'false'\n");
  const hiddenTarget='tests/.phase-hidden-check.py';
  const worker=join(repo,'worker.mjs');
  writeFileSync(worker,`import {existsSync,writeFileSync} from 'node:fs';\nfor await (const _ of process.stdin){}\nwriteFileSync('worker-saw-hidden.txt',String(existsSync(${JSON.stringify(hiddenTarget)}) || existsSync('../operator/hidden_check.py') || existsSync('/proc/1/root')));\nwriteFileSync('app.txt','right\\n');\n`);
  const config=join(operator,'task.json');
  writeFileSync(config,JSON.stringify({id:'firewall-test',cwd:repo,task:'repair the app',worker:{adapter:'exec',argv:['node',worker],prompt:'stdin'},verify:{public:['python public_check.py'],hidden:[`python ${hiddenTarget}`]},hidden:{install:[{from:hiddenSource,to:hiddenTarget}],paths:[hiddenTarget]},training:{enabled:true}},null,2));
  try{
    const r=await runHarness(config);
    assert.equal(r.passed,true);
    assert.equal(readFileSync(join(repo,'worker-saw-hidden.txt'),'utf8'),'false');
    assert.equal(existsSync(join(repo,hiddenTarget)),false);
    assert.equal(r.firewall.brainFrozen,true);
    assert.equal(r.firewall.auditPassed,true);
    assert.equal(r.firewall.osIsolation.available,true);
    assert.equal(r.firewall.osIsolation.backend,'linux-chroot');
    assert.equal(r.firewall.osIsolation.failClosed,true);
    assert.equal(r.hiddenValidation.length,1);
    assert.equal(r.hiddenValidation[0].status,0);
    assert.ok(existsSync(r.reportPath));
    const html=readFileSync(r.reportPath,'utf8');
    assert.match(html,/Hidden evaluator firewall/);
    assert.match(html,/Repository behavior graph/);
    const behaviorPath=join(dirname(r.resultPath),'training','accepted.repo-behavior.jsonl');
    assert.ok(existsSync(behaviorPath));
    const targets=readFileSync(behaviorPath,'utf8');
    assert.doesNotMatch(targets,/right\\n/);
    assert.doesNotMatch(targets,/hidden_check\.py/);
    const manifest=JSON.parse(readFileSync(join(dirname(r.resultPath),'training','export-manifest.json'),'utf8'));
    assert.equal(manifest.privacy.patchTextInTargets,false);
    assert.equal(manifest.privacy.hiddenTestBodies,false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('operator config must stay outside worktree by default', () => {
  const root=mkdtempSync(join(tmpdir(),'phase-config-boundary-'));initRepo(root);const p=join(root,'task.json');
  writeFileSync(p,JSON.stringify({cwd:root,task:'x',worker:{adapter:'shell',command:'true'}}));
  try{const cfg=loadHarnessConfig(p);assert.throws(()=>validateHarnessBoundary(cfg),/must live outside/);}finally{rmSync(root,{recursive:true,force:true});}
});

test('dashboard server exposes generated run report', async () => {
  const root=mkdtempSync(join(tmpdir(),'phase-dashboard-'));const rdir=join(root,'one');mkdirSync(rdir,{recursive:true});
  writeFileSync(join(rdir,'result.json'),JSON.stringify({runId:'one',passed:true,task:'demo',worker:{label:'Pi'},wallTimeMs:12,hiddenValidation:[],controller:{trace:[]}}));
  writeFileSync(join(rdir,'report.html'),'<h1>RUN ONE</h1>');
  const {server,url}=startDashboard({runsDir:root,port:0});
  try{await new Promise(resolve=>server.once('listening',resolve));const addr=server.address();const base=`http://127.0.0.1:${addr.port}`;const index=await (await fetch(base)).text();assert.match(index,/demo/);const report=await (await fetch(`${base}/run/one`)).text();assert.match(report,/RUN ONE/);}finally{server.close();rmSync(root,{recursive:true,force:true});}
});

import { buildDataset } from '../src/dataset.mjs';

test('dataset builder aggregates validated behavior without patch or hidden-test targets', () => {
  const root=mkdtempSync(join(tmpdir(),'phase-dataset-'));const run=join(root,'runs','r1');mkdirSync(join(run,'training'),{recursive:true});
  writeFileSync(join(run,'result.json'),JSON.stringify({passed:true,worker:{id:'pi'},controller:{trace:[{behavior:'inspect'},{behavior:'delegate'}]},hiddenValidation:[{status:0}]}));
  writeFileSync(join(run,'training','accepted.repo-behavior.jsonl'),JSON.stringify({id:'a1',target:{behavior:'inspect'},state:{task:'x'}})+'\n');
  writeFileSync(join(run,'training','outcome.jsonl'),JSON.stringify({runId:'r1',passed:true})+'\n');
  try{const out=join(root,'dataset');const m=buildDataset({runsDir:join(root,'runs'),outDir:out});assert.equal(m.runs,1);assert.equal(m.behaviorExamples,1);assert.equal(m.privacy.containsPatchTargets,false);assert.equal(m.privacy.containsHiddenTestBodies,false);assert.ok(existsSync(join(out,'phase.repo-behavior.jsonl')));}finally{rmSync(root,{recursive:true,force:true});}
});
