import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileWorkerInvocation, detectAvailableAdapters, resolveWorkerAdapter } from '../src/adapters.mjs';
import { runCloudWorker } from '../src/cloud-worker.mjs';

test('generic exec adapter passes prompt on stdin without shell interpolation', async () => {
  const root=mkdtempSync(join(tmpdir(),'phase-adapter-'));const script=join(root,'worker.mjs');
  writeFileSync(script,`import {writeFileSync} from 'node:fs';let s='';for await(const c of process.stdin)s+=c;writeFileSync('seen.txt',s);`);
  try {
    const adapter=resolveWorkerAdapter({adapter:'exec',argv:['node',script],prompt:'stdin'});
    const prompt=`quote ' ; touch SHOULD_NOT_EXIST ; $HOME`;
    const r=await runCloudWorker({cwd:root,prompt,adapter});
    assert.equal(r.ok,true);assert.equal(readFileSync(join(root,'seen.txt'),'utf8'),prompt);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('argv prompt transport preserves prompt as one argument', async () => {
  const root=mkdtempSync(join(tmpdir(),'phase-adapter-'));const script=join(root,'worker.mjs');
  writeFileSync(script,`import {writeFileSync} from 'node:fs';writeFileSync('seen.txt',process.argv[2]);`);
  try {
    const adapter=resolveWorkerAdapter({adapter:'exec',argv:['node',script,'{prompt}'],prompt:'argv'});
    const prompt=`hello ' " ; $(touch nope)`;
    const r=await runCloudWorker({cwd:root,prompt,adapter});
    assert.equal(r.ok,true);assert.equal(readFileSync(join(root,'seen.txt'),'utf8'),prompt);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('external JSON manifest defines an agent without Phase source changes', () => {
  const root=mkdtempSync(join(tmpdir(),'phase-manifest-'));const configDir=join(root,'operator');mkdirSync(configDir);const manifest=join(configDir,'agent.json');
  writeFileSync(manifest,JSON.stringify({id:'future-agent',label:'Future Agent',invocation:{argv:['future-agent','run','{prompt}'],prompt:'argv'},config_read:['./auth']}));mkdirSync(join(configDir,'auth'));
  try {
    const a=resolveWorkerAdapter({manifest:'./agent.json'},{baseDir:configDir});
    assert.equal(a.id,'future-agent');assert.deepEqual(a.argv,['future-agent','run','{prompt}']);assert.equal(a.prompt,'argv');assert.equal(a.isolationReadPaths.length,1);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('built-in model flag is inserted before prompt argument', () => {
  const a=resolveWorkerAdapter({adapter:'gemini',model:'gemini-test'});
  assert.deepEqual(a.argv.slice(-4),['--model','gemini-test','-p','{prompt}']);
  const compiled=compileWorkerInvocation(a,'do it');
  assert.equal(compiled.args.at(-1),'do it');
});

test('adapter discovery returns stable built-in catalog', () => {
  const ids=detectAvailableAdapters().map(x=>x.id);
  assert.deepEqual(ids,['pi','codex','claude','gemini','opencode','aider']);
});
