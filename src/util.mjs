import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

export function sha256(value) {
  const h = createHash("sha256");
  h.update(Buffer.isBuffer(value) ? value : String(value));
  return h.digest("hex");
}

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function publicId(prefix) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString("hex").toUpperCase()}`;
}

export function stringifyContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? null);
  return content.map((item) => {
    if (item?.type === "text") return item.text ?? "";
    return JSON.stringify(item);
  }).join("\n");
}

const REDACTIONS = [
  [/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/ig, "$1[REDACTED]"],
  [/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,"'}]+/ig, "$1[REDACTED]"],
  [/\b(?:ghp|github_pat)_[A-Za-z0-9_\-]+\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bsk-[A-Za-z0-9_\-]{16,}\b/g, "[REDACTED_API_KEY]"]
];

export function redactSecrets(text) {
  let out = String(text ?? "");
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function gitSnapshot(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return { root: null, commit: null, dirty: false, statusHash: null };
  const commit = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) ?? "";
  return { root, commit, dirty: status.length > 0, statusHash: sha256(status) };
}

export function artifactSnapshot(cwd, input) {
  const rawPath = input?.path;
  if (typeof rawPath !== "string" || !rawPath) return { path: null, hash: null };
  const path = resolve(cwd, rawPath);
  try {
    if (!existsSync(path)) return { path, hash: null };
    return { path, hash: sha256(readFileSync(path)) };
  } catch {
    return { path, hash: null };
  }
}

export function tokenize(text) {
  return [...new Set(String(text ?? "").toLowerCase().match(/[a-z0-9_./:-]{3,}/g) ?? [])];
}
