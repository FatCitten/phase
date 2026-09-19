#!/usr/bin/env node
import { runRepoController } from '../src/repo-controller.mjs';
const task = process.argv.slice(2).join(' ');
if (!task) { console.error('usage: node scripts/repo.mjs <task>'); process.exit(64); }
const result = await runRepoController({ task });
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 2;
