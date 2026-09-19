import { existsSync, readFileSync } from "node:fs";
import { sha256 } from "./util.mjs";

export function evidenceFreshness(observation) {
  if (!observation?.artifact_path || !observation?.artifact_sha256) {
    return { status: "untracked", reason: "evidence is not tied to a file snapshot" };
  }
  if (!existsSync(observation.artifact_path)) {
    return { status: "stale", reason: "supporting artifact no longer exists" };
  }
  try {
    const current = sha256(readFileSync(observation.artifact_path));
    if (current !== observation.artifact_sha256) {
      return { status: "stale", reason: "supporting artifact changed", currentHash: current };
    }
    return { status: "fresh", currentHash: current };
  } catch (error) {
    return { status: "unknown", reason: String(error) };
  }
}

export function claimFreshness(claim) {
  const evidence = (claim?.evidence ?? []).map((obs) => ({
    observationId: obs.public_id,
    artifactPath: obs.artifact_path,
    ...evidenceFreshness(obs)
  }));
  if (evidence.some((e) => e.status === "stale")) return { status: "stale", evidence };
  if (evidence.some((e) => e.status === "unknown")) return { status: "unknown", evidence };
  if (evidence.some((e) => e.status === "fresh")) return { status: "fresh", evidence };
  return { status: "untracked", evidence };
}
