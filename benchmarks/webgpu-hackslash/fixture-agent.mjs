#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
let prompt='';for await(const c of process.stdin)prompt+=c;
const repairing=/\bMODE\s*\nrepair\b/i.test(prompt)||/LAST VALIDATION/i.test(prompt);
const source=resolve(here,'templates',repairing?'final':'broken');
mkdirSync(resolve(process.cwd(),'src'),{recursive:true});
for(const rel of ['index.html','src/game.js','src/shader.wgsl'])cpSync(resolve(source,rel),resolve(process.cwd(),rel));
console.log(repairing?'Repaired melee combat and acceptance gaps.':'Implemented initial WebGPU raycast hack-and-slash pass.');
