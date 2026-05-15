// lib/discovery/paths.ts
import path from "node:path";
import { requireUserRoot } from "../storage/activeUserContext";

function discoveryDir(): string {
  return path.join(requireUserRoot(), "discovery");
}

export function getDiscoveryDir(): string {
  return discoveryDir();
}

export function getDiscoverySettingsPath(): string {
  return path.join(discoveryDir(), "settings.json");
}

export function getDiscoveryJobsPath(): string {
  return path.join(discoveryDir(), "jobs.jsonl");
}

export function getDiscoveryEvaluatedIdsPath(): string {
  return path.join(discoveryDir(), "evaluated_ids.json");
}

export function getDiscoveryNewMatchesPath(): string {
  return path.join(discoveryDir(), "new_matches.jsonl");
}

export function getDiscoveryNonMatchesPath(): string {
  return path.join(discoveryDir(), "non_matches.jsonl");
}

export function getDiscoveryProgressPath(): string {
  return path.join(discoveryDir(), "progress.json");
}

export function getDiscoveryEvalQueuePath(): string {
  return path.join(discoveryDir(), "eval_queue.json");
}

export function getDiscoveryEvalFailuresPath(): string {
  return path.join(discoveryDir(), "eval_failures.json");
}

export function getDiscoverySuppressedIdsPath(): string {
  return path.join(discoveryDir(), "suppressed_ids.json");
}

export function getDiscoveryDupeIndexPath(): string {
  return path.join(discoveryDir(), "dupe_index.json");
}

/** Per-user debug captures (screenshots / DOM dumps). */
export function getDiscoveryDebugDir(): string {
  return path.join(requireUserRoot(), "debug");
}
