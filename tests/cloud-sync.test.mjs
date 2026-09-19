import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startPhaseCloudServer } from '../src/cloud-server.mjs';
import { PhaseCloudClient, aggregateRunResult, aggregateStep } from '../src/cloud-sync.mjs';

test('premium websocket sync separates private and aggregate product streams', async () => {
  const dir=mkdtempSync(join(tmpdir(),'phase-cloud-test-'));
  const privateLog=join(dir,'private.ndjson'), productLog=join(dir,'product.ndjson');
  const cloud=await startPhaseCloudServer({apiKeys:{secret:{account:'acct-1',premium:true}},privateLog,productLog});
  const client=new PhaseCloudClient({enabled:true,url:cloud.url,apiKey:'secret',telemetry:'trace',dataProduct:'aggregate',timeoutMs:1500},{runId:'r1',repositoryId:'R1',clientVersion:'test'});
  assert.equal(await client.connect(),true);
  const step={step:2,behavior:'validate',isError:false,state:{validationAttempted:true,validationPassed:true,workerRuns:1,repairs:0}};
  assert.equal(await client.emit('controller.step',{...step,raw:'private-source'},aggregateStep(step)),true);
  await client.close();
  await new Promise(r=>setTimeout(r,20));
  await cloud.close();
  const priv=JSON.parse(readFileSync(privateLog,'utf8').trim());
  const product=JSON.parse(readFileSync(productLog,'utf8').trim());
  assert.equal(priv.payload.raw,'private-source');
  assert.equal(product.payload.behavior,'validate');
  assert.equal('raw' in product.payload,false);
  assert.equal('account' in product,false);
  assert.equal('context' in product,false);
  assert.match(product.runFingerprint,/^[a-f0-9]{24}$/);
});

test('aggregate run result contains no task, cwd, diff, stdout, or prompt', () => {
  const out=aggregateRunResult({passed:true,task:'secret',cwd:'/private',worker:{id:'pi'},policy:'heuristic',wallTimeMs:12,controller:{state:{workerRuns:2,repairs:1,validationPassed:true,reviewPassed:true},trace:[{behavior:'delegate'},{behavior:'repair'}]},audit:{passed:true},firewall:{hiddenCommands:1,osIsolation:{backend:'linux-chroot'}}});
  const text=JSON.stringify(out);
  for(const forbidden of ['secret','/private','diff','stdout','prompt']) assert.equal(text.includes(forbidden),false);
  assert.equal(out.repairs,1);
  assert.deepEqual(out.behaviors,['delegate','repair']);
});
