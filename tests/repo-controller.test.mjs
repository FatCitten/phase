import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runRepoController } from '../src/repo-controller.mjs';
import { BrainStore } from '../src/store.mjs';
import { compileBehaviorDataset } from '../src/behavior-forge.mjs';
import { sha256 } from '../src/util.mjs';

function sh(cwd, ...args) { return execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8' }); }
function initRepo(dir) {
  sh(dir, 'git', 'init', '-q');
  sh(dir, 'git', 'config', 'user.email', 'test@example.com');
  sh(dir, 'git', 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'app.txt'), 'wrong\n');
  writeFileSync(join(dir, 'check.py'), "from pathlib import Path\nassert Path('app.txt').read_text() == 'right\\n'\n");
  sh(dir, 'git', 'add', '.'); sh(dir, 'git', 'commit', '-qm', 'init');
}

test('repo controller governs cloud coding worker without generating code itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-repo-controller-'));
  initRepo(dir);
  const worker = join(dir, 'worker.mjs');
  writeFileSync(worker, "import {writeFileSync} from 'node:fs'; let s=''; for await (const c of process.stdin) s+=c; writeFileSync('app.txt','right\\n'); writeFileSync('seen-db.txt', process.env.PHASE_DB ?? ''); console.log('worker changed app.txt');\n");
  process.env.PHASE_VALIDATE_COMMAND = 'python check.py';
  try {
    const db = join(dir, '.phase', 'brain.sqlite');
    const result = await runRepoController({ cwd: dir, task: 'make app.txt correct', dbPath: db, cloudCommand: `node ${JSON.stringify(worker)}`, policy: 'heuristic', maxSteps: 10 });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(dir, 'app.txt'), 'utf8'), 'right\n');
    assert.equal(readFileSync(join(dir, 'seen-db.txt'), 'utf8'), db);
    assert.deepEqual(result.trace.map(x => x.behavior), ['inspect','delegate','validate','review','consolidate','finish']);
    const store = new BrainStore(db);
    const controllerActions = store.listSessionActions(result.sessionId).filter(x => x.tool_name.startsWith('repo:'));
    assert.equal(controllerActions.length, 6);
    assert.equal(controllerActions.some(x => JSON.stringify(x.input).includes('right\\n')), false);
    assert.equal(store.verifyLedger().ok, true);
    store.close();
  } finally {
    delete process.env.PHASE_VALIDATE_COMMAND;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('behavior forge targets repo behavior, not patches or code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-behavior-forge-'));
  initRepo(dir);
  const worker = join(dir, 'worker.mjs');
  writeFileSync(worker, "import {writeFileSync} from 'node:fs'; for await (const _ of process.stdin){} writeFileSync('app.txt','right\\n');\n");
  process.env.PHASE_VALIDATE_COMMAND = 'python check.py';
  try {
    const db = join(dir, '.phase', 'brain.sqlite');
    const result = await runRepoController({ cwd: dir, task: 'repair app', dbPath: db, cloudCommand: `node ${JSON.stringify(worker)}`, maxSteps: 10 });
    const suite = { brainDb: db, results: [{ task: 't1', result: { ...result, passed: result.ok } }] };
    const suitePath = join(dir, 'suite.json'); writeFileSync(suitePath, JSON.stringify(suite));
    const out = join(dir, 'forge');
    const manifest = compileBehaviorDataset({ suiteResultPath: suitePath, outDir: out });
    assert.equal(manifest.acceptedExamples, 6);
    const rows = readFileSync(join(out, 'accepted.repo-behavior.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(r => r.target.behavior), ['inspect','delegate','validate','review','consolidate','finish']);
    assert.equal(rows.some(r => JSON.stringify(r.target).includes('app.txt')), false);
    assert.equal(rows.some(r => JSON.stringify(r.target).includes('right')), false);
  } finally {
    delete process.env.PHASE_VALIDATE_COMMAND;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('behavior forge can distill high-level repository behavior from successful cloud-agent tool traces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-cloud-behavior-'));
  const db = join(dir, 'brain.sqlite');
  const store = new BrainStore(db);
  try {
    const sid = store.startSession({ cwd: dir });
    const prompt = 'fix the failing sum function';
    store.addObservation({ sessionId: sid, toolName: '__user_prompt__', input: {}, outputText: prompt, outputSha256: sha256(prompt), rawOutputSha256: sha256(prompt), cwd: dir });
    const acts = [
      ['read', {path:'calc.py'}, false],
      ['grep', {pattern:'sum_to'}, false],
      ['edit', {path:'calc.py', oldText:'range(n)', newText:'range(n+1)'}, false],
      ['bash', {command:'python -m pytest -q'}, false],
      ['bash', {command:'git diff --check'}, false]
    ];
    for (let i=0;i<acts.length;i++) {
      const [tool,input,isError] = acts[i]; const tc=`tc${i}`;
      store.addAction({sessionId:sid, toolCallId:tc, toolName:tool, input});
      store.completeAction(tc,{resultText:isError?'failed':'ok',isError});
    }
    store.endSession(sid);
    const head=store.ledgerHead(); store.close();
    const suitePath=join(dir,'suite.json');
    writeFileSync(suitePath, JSON.stringify({brainDb:db,results:[{task:'t',result:{sessionId:sid,passed:true,ledgerHeadBeforeHidden:head}}]}));
    const out=join(dir,'forge');
    const manifest=compileBehaviorDataset({suiteResultPath:suitePath,outDir:out});
    assert.equal(manifest.sources[0].traceType,'cloud-agent-inferred');
    const rows=readFileSync(join(out,'accepted.repo-behavior.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(r=>r.target.behavior),['inspect','delegate','validate','review','consolidate','finish']);
    assert.equal(rows.some(r=>JSON.stringify(r.target).includes('range(n+1)')),false);
  } finally { try{store.close();}catch{} rmSync(dir,{recursive:true,force:true}); }
});

test('repo controller repairs after failed validation instead of learning patch synthesis', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-repo-repair-'));
  initRepo(dir);
  const worker = join(dir, 'worker.mjs');
  writeFileSync(worker, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';\nfor await (const _ of process.stdin){}\nconst n=existsSync('.worker-count')?Number(readFileSync('.worker-count','utf8')):0;\nwriteFileSync('.worker-count',String(n+1));\nwriteFileSync('app.txt',n===0?'still-wrong\\n':'right\\n');\n`);
  process.env.PHASE_VALIDATE_COMMAND = 'python check.py';
  try {
    const result = await runRepoController({ cwd: dir, task: 'repair app', dbPath: join(dir,'.phase','brain.sqlite'), cloudCommand: `node ${JSON.stringify(worker)}`, maxSteps: 12, maxRepairs: 2 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.trace.map(x=>x.behavior), ['inspect','delegate','validate','repair','validate','review','consolidate','finish']);
  } finally { delete process.env.PHASE_VALIDATE_COMMAND; rmSync(dir,{recursive:true,force:true}); }
});
