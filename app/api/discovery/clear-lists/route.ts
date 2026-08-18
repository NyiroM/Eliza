import { NextRequest, NextResponse } from "next/server";
import { withActiveUser } from "../../../../lib/api/withActiveUser";
import { withDiscoverySyncLock } from "../../../../lib/discovery/lock";
import { suppressAndClearAllEvaluatedLists } from "../../../../lib/discovery/suppressAllEvaluatedLists";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

/** POST — suppress every row in new_matches.jsonl and non_matches.jsonl, then empty both files. */
export async function POST(request: NextRequest) {
  return withActiveUser(request, async () => {
    try {
      const result = await withDiscoverySyncLock(async () => suppressAndClearAllEvaluatedLists());
      return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "DISCOVERY_LOCKED") {
        return NextResponse.json(
          { ok: false, error: "Discovery is busy (sync or queue processing). Try again when it finishes." },
          { status: 409, headers: NO_STORE },
        );
      }
      console.error("[discovery/clear-lists]", msg);
      return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: NO_STORE });
    }
  });
}
