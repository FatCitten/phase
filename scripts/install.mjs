#!/usr/bin/env node
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../src");
const args = process.argv.slice(2);
let target;
if (args[0] === "--project") {
  const root = resolve(args[1] ?? ".");
  target = join(root, ".pi", "extensions", "phase");
} else if (args[0] === "--global" || args.length === 0) {
  target = join(homedir(), ".pi", "agent", "extensions", "phase");
} else {
  console.error("usage: node scripts/install.mjs [--global | --project /path/to/repo]");
  process.exit(64);
}
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true, force: true });
console.log(`Installed Phase Pi extension to ${target}`);
console.log("Restart Pi or run /reload in an existing trusted session.");
