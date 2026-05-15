// lib/discovery/resetDiscoveryCatalog.ts
// Wipe local discovery catalog and pipeline “seen” state so the next sync can treat jobs as new.
import { mkdir, writeFile } from "node:fs/promises";
import {
  getDiscoveryDir,
  getDiscoveryDupeIndexPath,
  getDiscoveryEvalFailuresPath,
  getDiscoveryEvalQueuePath,
  getDiscoveryEvaluatedIdsPath,
  getDiscoveryJobsPath,
} from "./paths";

export type ResetDiscoveryCatalogResult = {
  ok: true;
  cleared: {
    jobs_jsonl: boolean;
    evaluated_ids: boolean;
    eval_queue: boolean;
    eval_failures: boolean;
    dupe_index: boolean;
  };
};

/** Truncate jobs.jsonl and reset evaluated ids, eval queue, eval failure store, and cross-provider dupe index. */
export async function resetDiscoveryCatalogForDuplicateFilter(): Promise<ResetDiscoveryCatalogResult> {
  await mkdir(getDiscoveryDir(), { recursive: true });
  await writeFile(getDiscoveryJobsPath(), "", "utf-8");
  await writeFile(getDiscoveryEvaluatedIdsPath(), JSON.stringify([], null, 2), "utf-8");
  await writeFile(getDiscoveryEvalQueuePath(), JSON.stringify({ items: [] }, null, 2), "utf-8");
  await writeFile(getDiscoveryEvalFailuresPath(), JSON.stringify({ items: [] }, null, 2), "utf-8");
  await writeFile(
    getDiscoveryDupeIndexPath(),
    JSON.stringify(
      { version: 1, updated_at: new Date().toISOString(), buckets: {} } as const,
      null,
      2,
    ),
    "utf-8",
  );
  return {
    ok: true,
    cleared: {
      jobs_jsonl: true,
      evaluated_ids: true,
      eval_queue: true,
      eval_failures: true,
      dupe_index: true,
    },
  };
}
