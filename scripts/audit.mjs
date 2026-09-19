#!/usr/bin/env node
import { resolve } from "node:path";
import { BrainStore } from "../src/store.mjs";
import { PhaseAssociativeIndex, defaultPhaseIndexPath } from "../src/phase-index.mjs";

function parse(argv) {
  const out = { db: null, deny: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") out.db = argv[++i];
    else if (argv[i] === "--deny") out.deny.push(argv[++i]);
  }
  if (!out.db) throw new Error("usage: node scripts/audit.mjs --db PATH [--deny PATTERN ...]");
  return out;
}

const args = parse(process.argv.slice(2));
const store = new BrainStore(resolve(args.db));
try {
  const provenance = store.audit(args.deny);
  const indexPath = process.env.PHASE_INDEX_PATH || defaultPhaseIndexPath(resolve(args.db));
  let index;
  try {
    const idx = PhaseAssociativeIndex.load(indexPath);
    idx.ensureSynced(store);
    index = idx.audit(store);
  } catch (error) {
    index = { passed: false, error: String(error) };
  }
  const result = { ...provenance, index, passed: provenance.passed && index.passed };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 2;
} finally {
  store.close();
}
