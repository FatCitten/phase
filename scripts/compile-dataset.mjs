#!/usr/bin/env node
import { resolve } from "node:path";
import { compileSuiteDataset } from "../src/forge.mjs";

const suite = process.argv[2];
const out = process.argv[3] ?? ".phase/forge";
if (!suite) {
  console.error("usage: node scripts/compile-dataset.mjs path/to/suite-result.json [out-dir]");
  process.exit(64);
}
const manifest = compileSuiteDataset({ suiteResultPath: resolve(suite), outDir: resolve(out) });
console.log(JSON.stringify(manifest, null, 2));
