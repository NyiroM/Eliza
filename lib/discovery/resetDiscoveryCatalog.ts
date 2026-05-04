// lib/discovery/resetDiscoveryCatalog.ts
// Wipe local discovery catalog and pipeline “seen” state so the next sync can treat jobs as new.
import { mkdir, writeFile } from "node:fs/promises";
import {
  DISCOVERY_DIR,
  DISCOVERY_EVAL_FAILURES_PATH,
  DISCOVERY_EVAL_QUEUE_PATH,
  DISCOVERY_EVALUATED_IDS_PATH,
  DISCOVERY_JOBS_PATH,
} from "./paths";

export type ResetDiscoveryCatalogResult = {
  ok: true;
  cleared: {
    jobs_jsonl: boolean;
    evaluated_ids: boolean;
    eval_queue: boolean;
    eval_failures: boolean;
  };
};

/** Truncate jobs.jsonl and reset evaluated ids, eval queue, and eval failure store. */
export async function resetDiscoveryCatalogForDuplicateFilter(): Promise<ResetDiscoveryCatalogResult> {
  await mkdir(DISCOVERY_DIR, { recursive: true });
  await writeFile(DISCOVERY_JOBS_PATH, "", "utf-8");
  await writeFile(DISCOVERY_EVALUATED_IDS_PATH, JSON.stringify([], null, 2), "utf-8");
  await writeFile(DISCOVERY_EVAL_QUEUE_PATH, JSON.stringify({ items: [] }, null, 2), "utf-8");
  await writeFile(DISCOVERY_EVAL_FAILURES_PATH, JSON.stringify({ items: [] }, null, 2), "utf-8");
  return {
    ok: true,
    cleared: {
      jobs_jsonl: true,
      evaluated_ids: true,
      eval_queue: true,
      eval_failures: true,
    },
  };
}
