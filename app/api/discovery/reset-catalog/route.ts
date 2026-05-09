import { NextResponse } from "next/server";
import { clearDiscoveryProgress } from "../../../../lib/discovery/progress";
import { markDiscoveryAwaitingDrain, withDiscoverySyncLock } from "../../../../lib/discovery/lock";
import { resetDiscoveryCatalogForDuplicateFilter } from "../../../../lib/discovery/resetDiscoveryCatalog";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

/** POST — clears jobs.jsonl, evaluated_ids, eval queue, eval failures, and dupe_index (manual duplicate-filter reset). */
export async function POST() {
  try {
    const result = await withDiscoverySyncLock(async () => {
      const r = await resetDiscoveryCatalogForDuplicateFilter();
      markDiscoveryAwaitingDrain(false);
      await clearDiscoveryProgress().catch(() => {});
      return r;
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "DISCOVERY_LOCKED") {
      return NextResponse.json(
        { ok: false, error: "Discovery is busy (sync or queue processing). Try again when it finishes." },
        { status: 409, headers: NO_STORE },
      );
    }
    console.error("[discovery/reset-catalog]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: NO_STORE });
  }
}
