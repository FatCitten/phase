#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const experiments=resolve(process.argv[2]??'.phase/experiments');
const dataset=resolve(process.argv[3]??'.phase/allocator-dataset');
const model=resolve(process.argv[4]??'.phase/models/allocator');
mkdirSync(dataset,{recursive:true});mkdirSync(model,{recursive:true});
let r=spawnSync(process.execPath,[resolve('scripts/compile-allocator-dataset.mjs'),experiments,dataset],{stdio:'inherit'});if((r.status??1)!==0)process.exit(r.status??1);
const chat=resolve(dataset,'allocator-chat.jsonl');if(!existsSync(chat))throw new Error('allocator dataset was not produced');
const py=process.env.PHASE_PYTHON??'python3';
r=spawnSync(py,[resolve('training/train_allocator.py'),chat,'--output',model],{stdio:'inherit'});if((r.status??1)!==0){console.error('\nJIT training did not complete. The measured dataset is preserved; install training/requirements.txt and rerun.');process.exit(r.status??1);}console.log(`\nPhase allocator adapter: ${model}`);
