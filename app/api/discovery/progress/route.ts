import { NextResponse } from "next/server";
import type { DiscoveryProgressState } from "../../../../types/discovery";
import { getEvalQueueLength } from "../../../../lib/discovery/evalQueue";
import { clearDiscoveryProgress, readDiscoveryProgress } from "../../../../lib/discovery/progress";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

function isAwaitingClientDrainMessage(progress: DiscoveryProgressState): boolean {
  if (progress.phase !== "queueing") return false;
  const m = (progress.message ?? "").toLowerCase();
  return m.includes("queued for deep") || m.includes("continuing in the background");
}

export async function GET() {
  let progress = await readDiscoveryProgress();
  if (isAwaitingClientDrainMessage(progress)) {
    const len = await getEvalQueueLength();
    if (len === 0) {
      await clearDiscoveryProgress().catch(() => {});
      progress = await readDiscoveryProgress();
    }
  }
  return NextResponse.json(progress, { headers: NO_STORE });
}
