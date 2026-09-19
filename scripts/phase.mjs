#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { runHarness } from '../src/harness-runner.mjs';
import { writeRunReport } from '../src/run-report.mjs';
import { startDashboard } from '../src/dashboard-server.mjs';
import { exportRunTrainingData } from '../src/training-export.mjs';
import { buildDataset } from '../src/dataset.mjs';

function usage(){console.log(`Phase v0.6\n\n  phase init <config.json> [repo]\n  phase run <config.json>\n  phase report <result.json> [out.html]\n  phase export <result.json> [--private]\n  phase ui [runs-dir] [--port 4317]\n  phase dataset <runs-dir> <out-dir> [--portable]\n`)}
function template(cwd){return{id:'fix-example',cwd,task:'Describe the coding task here',worker:{adapter:'pi'},verify:{public:['npm test'],hidden:['npm test -- --runInBand']},hidden:{install:[{from:'/absolute/operator-only/hidden.test.js',to:'tests/.phase-hidden.test.js'}],paths:['tests/.phase-hidden.test.js']},isolation:{enabled:true,required:true,read:[]},governor:{policy:'heuristic',max_repairs:2},training:{enabled:true,export_full_private_trace:false},report:{enabled:true,title:'Phase coding run'}};}
const [cmd,...args]=process.argv.slice(2);if(!cmd){usage();process.exit(64)}
if(cmd==='init'){const out=resolve(args[0]??'../phase-task.json');const cwd=resolve(args[1]??'.');mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(template(cwd),null,2));console.log(`Wrote ${out}\nKeep this operator config outside the agent worktree.`);}
else if(cmd==='run'){if(!args[0]){usage();process.exit(64)}const r=await runHarness(args[0],{onStep:(x)=>console.log(`${String(x.step).padStart(2,'0')} ${x.behavior.toUpperCase()}${x.isError?' !':''}`)});console.log(`\n${r.passed?'PASS':'FAIL'}\nresult: ${r.resultPath}${r.reportPath?`\nreport: ${r.reportPath}`:''}`);process.exitCode=r.passed?0:2;}
else if(cmd==='report'){const p=resolve(args[0]??'');if(!existsSync(p))throw new Error('result.json not found');const x=JSON.parse(readFileSync(p,'utf8'));const out=resolve(args[1]??join(dirname(p),'report.html'));writeRunReport(x,out,{title:x.task??basename(dirname(p))});console.log(out);}
else if(cmd==='export'){const p=resolve(args[0]??'');if(!existsSync(p))throw new Error('result.json not found');const x=JSON.parse(readFileSync(p,'utf8'));const m=exportRunTrainingData({runResult:x,runDir:dirname(p),includePrivate:args.includes('--private')});console.log(JSON.stringify(m,null,2));}
else if(cmd==='dataset'){const runs=resolve(args[0]??'.phase/runs');const out=resolve(args[1]??'phase-dataset');const m=buildDataset({runsDir:runs,outDir:out,portable:args.includes('--portable')});console.log(JSON.stringify(m,null,2));}
else if(cmd==='ui'){const p=args.find(x=>!x.startsWith('--'))??resolve('.phase','runs');const pi=args.indexOf('--port');const port=pi>=0?Number(args[pi+1]):4317;const d=startDashboard({runsDir:p,port});console.log(`Phase UI ${d.url}\nRuns: ${d.runsDir}`);}
else{usage();process.exit(64)}
