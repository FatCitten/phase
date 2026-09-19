#!/usr/bin/env node
import { compileBehaviorDataset } from '../src/behavior-forge.mjs';
const [suite, out = 'forge-behavior'] = process.argv.slice(2);
if (!suite) { console.error('usage: node scripts/compile-behavior-dataset.mjs suite-result.json [out-dir]'); process.exit(64); }
console.log(JSON.stringify(compileBehaviorDataset({ suiteResultPath: suite, outDir: out }), null, 2));
