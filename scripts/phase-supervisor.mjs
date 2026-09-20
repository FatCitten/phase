#!/usr/bin/env node
import { resolve } from 'node:path';
import { superviseProcess } from '../src/process-runtime.mjs';

const args = process.argv.slice(2);
const idx = args.indexOf('--run-dir');
if (idx < 0 || !args[idx + 1]) { console.error('usage: phase-supervisor --run-dir DIR [--foreground]'); process.exit(64); }
const runDir = resolve(args[idx + 1]);
const foreground = args.includes('--foreground');
try {
  const result = await superviseProcess({ runDir, foreground });
  process.exitCode = Number.isInteger(result.exit_code) ? result.exit_code : 1;
} catch (error) {
  console.error(`[phase] supervisor error: ${error.stack || error.message}`);
  process.exitCode = 1;
}
