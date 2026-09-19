import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCloudWorker } from '../src/cloud-worker.mjs';
import { buildIsolationPlan, probeWorkerIsolation } from '../src/worker-isolation.mjs';

test('isolation plan refuses a read allowlist that would expose evaluator assets', () => {
  const root=mkdtempSync(join(tmpdir(),'phase-isolation-plan-'));const repo=join(root,'repo'),operator=join(root,'operator');mkdirSync(repo);mkdirSync(operator);
  const secret=join(operator,'hidden.py');writeFileSync(secret,'SECRET');
  try { assert.throws(()=>buildIsolationPlan({cwd:repo,command:'node -e "0"',readPaths:[operator],protectedPaths:[secret]}),/would expose protected evaluator asset/); }
  finally {rmSync(root,{recursive:true,force:true});}
});

test('linux chroot worker cannot traverse to sibling evaluator or remount proc', async (t) => {
  const probe=probeWorkerIsolation(); if(!probe.available){t.skip(`OS isolation unavailable: ${probe.reason}`);return;}
  const root=mkdtempSync(join(tmpdir(),'phase-isolation-'));const repo=join(root,'repo'),operator=join(root,'operator');mkdirSync(repo);mkdirSync(operator);
  const secret=join(operator,'hidden.txt');writeFileSync(secret,'SECRET');
  const command=`bash -c 'set +e; cat ../operator/hidden.txt > direct.out 2>&1; mount -t proc proc /proc > mount.out 2>&1; cat /proc/1/root${secret} > proc.out 2>&1; node -e "require(\\"fs\\").writeFileSync(\\"alive.txt\\",\\"yes\\")"'`;
  try {
    const result=await runCloudWorker({cwd:repo,prompt:'',command,isolation:{enabled:true,required:true,protectedPaths:[secret]}});
    assert.equal(result.ok,true);
    assert.equal(result.isolation.backend,'linux-chroot');
    assert.equal(readFileSync(join(repo,'alive.txt'),'utf8'),'yes');
    assert.doesNotMatch(readFileSync(join(repo,'direct.out'),'utf8'),/SECRET/);
    assert.match(readFileSync(join(repo,'mount.out'),'utf8'),/permission denied/i);
    assert.doesNotMatch(readFileSync(join(repo,'proc.out'),'utf8'),/SECRET/);
    assert.equal(existsSync(join(repo,'../operator/hidden.txt')),true); // host still owns it; only worker namespace was restricted.
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('sandbox config copies are writable for the agent without mutating host credentials', async (t) => {
  const probe=probeWorkerIsolation(); if(!probe.available){t.skip(`OS isolation unavailable: ${probe.reason}`);return;}
  const root=mkdtempSync(join(tmpdir(),'phase-isolation-copy-'));const repo=join(root,'repo'),agent=join(root,'agent');mkdirSync(repo);mkdirSync(agent);
  const auth=join(agent,'auth.json');writeFileSync(auth,'{"token":"original"}\n');
  const command=`node -e ${JSON.stringify(`const fs=require('fs');const p=${JSON.stringify(auth)};const before=fs.readFileSync(p,'utf8');fs.writeFileSync(p,'{\\"token\\":\\"refreshed\\"}\\n');fs.writeFileSync('copy-result.txt',before+'|'+fs.readFileSync(p,'utf8'))`)}`;
  try {
    const result=await runCloudWorker({cwd:repo,prompt:'',command,isolation:{enabled:true,required:true,copyPaths:[agent]}});
    assert.equal(result.ok,true);
    assert.match(readFileSync(join(repo,'copy-result.txt'),'utf8'),/original.*refreshed/s);
    assert.equal(readFileSync(auth,'utf8'),'{"token":"original"}\n');
    assert.equal(result.isolation.copiedConfigPaths,1);
  } finally {rmSync(root,{recursive:true,force:true});}
});
