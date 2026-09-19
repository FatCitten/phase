import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { stableJson, sha256 } from "./util.mjs";

const TWO_PI = Math.PI * 2;
const DEFAULT_MODULI = [8, 9, 5, 7, 11, 13];
const DEFAULT_REPS = 8192;             // dim=49,152 => 768 KiB fixed complex vector
const DEFAULT_GATE = 0.45;
const DEFAULT_BUCKETS = 512;           // cleanup alphabet is fixed, never grows with claims
const DEFAULT_BUCKET_CLAIMS = 32;      // bounded candidate fan-out per recalled bucket
const INDEX_SCHEMA = 2;
const MEMORY_ID = /^M[A-Z0-9]+$/;
const STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "when", "then", "than", "have", "has",
  "are", "was", "were", "will", "would", "should", "could", "not", "but", "use", "using", "used", "your",
  "you", "its", "our", "their", "they", "them", "can", "all", "any", "each", "file", "code", "repo", "repository",
  "owns", "contains", "does", "where", "what", "which", "about", "work", "works", "make", "makes", "made"
]);

function rotl(x, k) {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function xoshiro(cue) {
  const digest = createHash("sha256").update(cue).digest();
  let s0 = digest.readUInt32LE(0) || 0x9e3779b9;
  let s1 = digest.readUInt32LE(4) || 0x243f6a88;
  let s2 = digest.readUInt32LE(8) || 0xb7e15162;
  let s3 = digest.readUInt32LE(12) || 0xdeadbeef;
  return () => {
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3;
    s2 ^= t; s3 = rotl(s3, 11);
    return result / 0x100000000;
  };
}

function b64FromFloat64(array) {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString("base64");
}

function float64FromB64(text, expectedLength) {
  const raw = Buffer.from(text, "base64");
  if (raw.byteLength !== expectedLength * 8) throw new Error("phase vector byte length mismatch");
  const copy = Buffer.from(raw);
  return new Float64Array(copy.buffer, copy.byteOffset, expectedLength).slice();
}

function camelParts(token) {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.:/\\-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function cueScore(raw) {
  let score = Math.min(8, raw.length / 3);
  if (/[_.:/\\-]/.test(raw)) score += 10;
  if (/[a-z0-9][A-Z]/.test(raw)) score += 8;
  if (/\d/.test(raw)) score += 3;
  if (/^[A-Z][A-Za-z0-9_]+$/.test(raw)) score += 2;
  return score;
}

function claimCues(text, maxCues = 6) {
  const raw = String(text ?? "").match(/[A-Za-z0-9_./:\\-]{4,}/g) ?? [];
  const candidates = new Map();
  const add = (value, score) => {
    const cue = value.toLowerCase();
    if (cue.length < 4 || STOP.has(cue)) return;
    const key = `t:${cue}`;
    const prev = candidates.get(key);
    if (prev === undefined || score > prev) candidates.set(key, score);
  };
  for (const token of raw) {
    const score = cueScore(token);
    add(token, score);
    const parts = camelParts(token);
    if (parts.length > 1) {
      const useful = parts.filter((p) => p.length >= 4 && !STOP.has(p.toLowerCase()));
      for (const part of useful.slice(0, 2)) add(part, score - 1);
    }
  }
  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxCues)
    .map(([cue]) => cue);
}

function valuePhases(valueId, moduli) {
  return moduli.map((m) => {
    const angle = TWO_PI * (valueId % m) / m;
    return [Math.cos(angle), Math.sin(angle)];
  });
}

export class PhaseAssociativeIndex {
  constructor({
    moduli = DEFAULT_MODULI,
    reps = DEFAULT_REPS,
    minConfidence = DEFAULT_GATE,
    bucketCount = DEFAULT_BUCKETS,
    maxClaimsPerBucket = DEFAULT_BUCKET_CLAIMS,
    path = null
  } = {}) {
    this.moduli = [...moduli];
    this.reps = Number(reps);
    this.minConfidence = Number(minConfidence);
    this.bucketCount = Number(bucketCount);
    this.maxClaimsPerBucket = Number(maxClaimsPerBucket);
    this.dim = this.moduli.length * this.reps;
    this.capacity = this.moduli.reduce((a, b) => a * b, 1);
    if (this.bucketCount > this.capacity) throw new Error(`bucketCount ${this.bucketCount} exceeds CRT capacity ${this.capacity}`);
    this.path = path;
    this.real = new Float64Array(this.dim);
    this.imag = new Float64Array(this.dim);
    this.cue2bucket = new Map();
    this.bucket2claims = new Map();
    this.keyCache = new Map();
    this.claimDigest = null;
    this.noiseFloor = 0;
    this.effectiveGate = this.minConfidence;
    this.valueTable = Array.from({ length: this.bucketCount }, (_, id) => valuePhases(id, this.moduli));
  }

  static load(path) {
    if (!existsSync(path)) return new PhaseAssociativeIndex({ path });
    const d = JSON.parse(readFileSync(path, "utf8"));
    if (d.schema !== INDEX_SCHEMA) throw new Error(`unsupported phase index schema ${d.schema}`);
    const idx = new PhaseAssociativeIndex({
      moduli: d.moduli,
      reps: d.reps,
      minConfidence: d.minConfidence,
      bucketCount: d.bucketCount,
      maxClaimsPerBucket: d.maxClaimsPerBucket,
      path
    });
    idx.real = float64FromB64(d.realB64, idx.dim);
    idx.imag = float64FromB64(d.imagB64, idx.dim);
    idx.claimDigest = d.claimDigest ?? null;
    idx.noiseFloor = Number(d.noiseFloor ?? 0);
    idx.effectiveGate = Number(d.effectiveGate ?? idx.minConfidence);
    for (const [cue, bucket] of Object.entries(d.cue2bucket ?? {})) {
      if (!Number.isInteger(bucket) || bucket < 0 || bucket >= idx.bucketCount) throw new Error("invalid phase cue bucket");
      idx.cue2bucket.set(cue, bucket);
    }
    for (const [bucketText, ids] of Object.entries(d.bucket2claims ?? {})) {
      const bucket = Number(bucketText);
      if (!Number.isInteger(bucket) || bucket < 0 || bucket >= idx.bucketCount) throw new Error("invalid phase bucket id");
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string" && MEMORY_ID.test(x))) {
        throw new Error("unsafe phase bucket: index may contain only memory IDs");
      }
      idx.bucket2claims.set(bucket, ids.slice(0, idx.maxClaimsPerBucket));
    }
    return idx;
  }

  reset() {
    this.real.fill(0);
    this.imag.fill(0);
    this.cue2bucket.clear();
    this.bucket2claims.clear();
    this.keyCache.clear();
    this.claimDigest = null;
    this.noiseFloor = 0;
    this.effectiveGate = this.minConfidence;
  }

  #key(cue) {
    const cached = this.keyCache.get(cue);
    if (cached) return cached;
    const rng = xoshiro(cue);
    const real = new Float64Array(this.dim);
    const imag = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      const angle = TWO_PI * rng();
      real[i] = Math.cos(angle);
      imag[i] = Math.sin(angle);
    }
    const value = { real, imag };
    if (this.keyCache.size > 512) this.keyCache.delete(this.keyCache.keys().next().value);
    this.keyCache.set(cue, value);
    return value;
  }

  #applyBinding(cue, bucket, sign) {
    const key = this.#key(cue);
    for (let mi = 0; mi < this.moduli.length; mi++) {
      const [vr, vi] = this.valueTable[bucket][mi];
      const start = mi * this.reps;
      const end = start + this.reps;
      for (let i = start; i < end; i++) {
        const br = key.real[i] * vr - key.imag[i] * vi;
        const bi = key.real[i] * vi + key.imag[i] * vr;
        this.real[i] += sign * br;
        this.imag[i] += sign * bi;
      }
    }
  }

  #assignCue(cue) {
    if (this.cue2bucket.has(cue)) return this.cue2bucket.get(cue);
    // Assignment is arbitrary but deterministic under rebuild order; the phase vector, not this
    // bookkeeping map, is used on the recall hot path.
    const bucket = this.cue2bucket.size % this.bucketCount;
    this.#applyBinding(cue, bucket, +1);
    this.cue2bucket.set(cue, bucket);
    return bucket;
  }

  #addClaimToBucket(bucket, memoryId) {
    const prev = this.bucket2claims.get(bucket) ?? [];
    const next = [memoryId, ...prev.filter((x) => x !== memoryId)].slice(0, this.maxClaimsPerBucket);
    this.bucket2claims.set(bucket, next);
  }

  recall(cue) {
    if (this.cue2bucket.size === 0) return { hit: false, bucket: -1, confidence: 0, payload: null };
    const key = this.#key(cue);
    const blockSums = [];
    for (let mi = 0; mi < this.moduli.length; mi++) {
      let sumR = 0;
      let sumI = 0;
      const start = mi * this.reps;
      const end = start + this.reps;
      for (let i = start; i < end; i++) {
        // est = M * conj(key)
        sumR += this.real[i] * key.real[i] + this.imag[i] * key.imag[i];
        sumI += this.imag[i] * key.real[i] - this.real[i] * key.imag[i];
      }
      blockSums.push([sumR, sumI]);
    }

    let bestBucket = -1;
    let bestScore = -Infinity;
    // Matched-filter cleanup over a FIXED bucket alphabet. The scan cost is constant in
    // number of claims/cues and uses block sums, so it is bucketCount * #moduli, not bucketCount * dim.
    for (let bucket = 0; bucket < this.bucketCount; bucket++) {
      let score = 0;
      for (let mi = 0; mi < this.moduli.length; mi++) {
        const [vr, vi] = this.valueTable[bucket][mi];
        const [er, ei] = blockSums[mi];
        score += vr * er + vi * ei;
      }
      if (score > bestScore) {
        bestScore = score;
        bestBucket = bucket;
      }
    }
    const confidence = bestScore / this.dim;
    const payload = this.bucket2claims.get(bestBucket) ?? [];
    const hit = confidence >= this.effectiveGate && payload.length > 0;
    return { hit, bucket: bestBucket, confidence, payload: hit ? [...payload] : null };
  }

  calibrateNoise(probes = 24) {
    if (this.cue2bucket.size === 0) {
      this.noiseFloor = 0;
      this.effectiveGate = this.minConfidence;
      return this.effectiveGate;
    }
    const scores = [];
    for (let i = 0; i < probes; i++) {
      // Extremely unlikely to be a legitimate coding-memory cue; probe strings are never stored.
      const r = this.recall(`__phase_noise_probe_${i}_${this.cue2bucket.size}__`);
      scores.push(r.confidence);
    }
    scores.sort((a, b) => a - b);
    const p95 = scores[Math.min(scores.length - 1, Math.floor(scores.length * 0.95))] ?? 0;
    this.noiseFloor = p95;
    this.effectiveGate = Math.max(this.minConfidence, p95 + 0.12);
    return this.effectiveGate;
  }

  addClaim(memoryId, claim) {
    if (!MEMORY_ID.test(memoryId)) throw new Error(`invalid memory id ${memoryId}`);
    const cues = claimCues(claim);
    for (const cue of cues) {
      const bucket = this.#assignCue(cue);
      this.#addClaimToBucket(bucket, memoryId);
    }
    return cues.length;
  }

  search(query, limit = 8) {
    const cues = claimCues(query, 8);
    const scores = new Map();
    const recalls = [];
    for (const cue of cues) {
      const r = this.recall(cue);
      recalls.push({ cue, hit: r.hit, confidence: r.confidence, bucket: r.bucket });
      if (!r.hit || !Array.isArray(r.payload)) continue;
      for (let rank = 0; rank < r.payload.length; rank++) {
        const id = r.payload[rank];
        if (!MEMORY_ID.test(id)) continue;
        const prev = scores.get(id) ?? { id, score: 0, matches: 0, maxConfidence: 0 };
        prev.score += 1 + Math.max(0, r.confidence) + 0.25 / (rank + 1);
        prev.matches += 1;
        prev.maxConfidence = Math.max(prev.maxConfidence, r.confidence);
        scores.set(id, prev);
      }
    }
    const candidates = [...scores.values()]
      .sort((a, b) => b.score - a.score || b.matches - a.matches)
      .slice(0, Math.max(1, Number(limit)));
    return { candidates, cues, recalls };
  }

  rebuild(claims, digest = null) {
    this.reset();
    for (const row of claims) this.addClaim(row.public_id, row.claim);
    this.claimDigest = digest;
    this.calibrateNoise();
    this.save();
  }

  ensureSynced(store) {
    const digest = store.activeClaimDigest();
    if (this.claimDigest !== digest) this.rebuild(store.listActiveClaims(), digest);
    return digest;
  }

  save() {
    if (!this.path) return;
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.toJSON()));
    renameSync(tmp, this.path);
  }

  toJSON() {
    return {
      schema: INDEX_SCHEMA,
      algorithm: "phase-native-fixed-cleanup-buckets",
      moduli: this.moduli,
      reps: this.reps,
      minConfidence: this.minConfidence,
      bucketCount: this.bucketCount,
      maxClaimsPerBucket: this.maxClaimsPerBucket,
      dim: this.dim,
      capacityValues: this.capacity,
      claimDigest: this.claimDigest,
      noiseFloor: this.noiseFloor,
      effectiveGate: this.effectiveGate,
      realB64: b64FromFloat64(this.real),
      imagB64: b64FromFloat64(this.imag),
      cue2bucket: Object.fromEntries(this.cue2bucket.entries()),
      bucket2claims: Object.fromEntries([...this.bucket2claims.entries()].map(([k, v]) => [String(k), v]))
    };
  }

  stateHash() {
    return sha256(stableJson(this.toJSON()));
  }

  audit(store) {
    const expectedDigest = store.activeClaimDigest();
    const active = new Set(store.listActiveClaims().map((c) => c.public_id));
    const unsafe = [];
    const dangling = [];
    for (const [bucket, ids] of this.bucket2claims.entries()) {
      if (!Number.isInteger(bucket) || bucket < 0 || bucket >= this.bucketCount || !Array.isArray(ids)) unsafe.push(bucket);
      for (const id of ids) {
        if (!MEMORY_ID.test(id)) unsafe.push(bucket);
        else if (!active.has(id)) dangling.push(id);
      }
    }
    return {
      passed: unsafe.length === 0 && dangling.length === 0 && this.claimDigest === expectedDigest,
      algorithm: "phase-native-fixed-cleanup-buckets",
      claimDigest: this.claimDigest,
      expectedClaimDigest: expectedDigest,
      unsafeBuckets: [...new Set(unsafe)],
      danglingMemoryIds: [...new Set(dangling)],
      ...this.stats()
    };
  }

  stats() {
    return {
      cues: this.cue2bucket.size,
      populatedBuckets: this.bucket2claims.size,
      dim: this.dim,
      moduli: [...this.moduli],
      reps: this.reps,
      bucketCount: this.bucketCount,
      maxClaimsPerBucket: this.maxClaimsPerBucket,
      fixedVectorBytes: this.dim * 16,
      minConfidence: this.minConfidence,
      noiseFloor: this.noiseFloor,
      effectiveGate: this.effectiveGate,
      knownUnknownMargin: this.effectiveGate - this.noiseFloor,
      path: this.path
    };
  }
}

export function defaultPhaseIndexPath(dbPath) {
  return `${dbPath}.phase-index.json`;
}

export function loadPhaseIndexForStore(store) {
  const path = process.env.PHASE_INDEX_PATH || defaultPhaseIndexPath(store.dbPath);
  let idx;
  try {
    idx = PhaseAssociativeIndex.load(path);
  } catch {
    idx = new PhaseAssociativeIndex({ path });
  }
  idx.ensureSynced(store);
  return idx;
}
