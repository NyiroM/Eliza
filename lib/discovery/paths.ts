// lib/discovery/paths.ts
import path from "node:path";

const STORAGE = path.join(process.cwd(), "storage");
export const DISCOVERY_DIR = path.join(STORAGE, "discovery");
export const DISCOVERY_SETTINGS_PATH = path.join(DISCOVERY_DIR, "settings.json");
export const DISCOVERY_JOBS_PATH = path.join(DISCOVERY_DIR, "jobs.jsonl");
export const DISCOVERY_EVALUATED_IDS_PATH = path.join(DISCOVERY_DIR, "evaluated_ids.json");
export const DISCOVERY_NEW_MATCHES_PATH = path.join(DISCOVERY_DIR, "new_matches.jsonl");
export const DISCOVERY_NON_MATCHES_PATH = path.join(DISCOVERY_DIR, "non_matches.jsonl");
export const DISCOVERY_PROGRESS_PATH = path.join(DISCOVERY_DIR, "progress.json");
export const DISCOVERY_EVAL_QUEUE_PATH = path.join(DISCOVERY_DIR, "eval_queue.json");
export const DISCOVERY_EVAL_FAILURES_PATH = path.join(DISCOVERY_DIR, "eval_failures.json");
export const DISCOVERY_DEBUG_DIR = path.join(STORAGE, "debug");
