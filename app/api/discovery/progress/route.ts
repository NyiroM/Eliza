import { NextRequest, NextResponse } from "next/server";
import { withActiveUser } from "../../../../lib/api/withActiveUser";
import type { DiscoveryProgressState } from "../../../../types/discovery";
import { getEvalQueueActionableLength, getEvalQueueLength } from "../../../../lib/discovery/evalQueue";
import {
  clearDiscoveryProgress,
  defaultSessionLiveStats,
  readDiscoveryProgress,
  setDiscoveryProgress,
} from "../../../../lib/discovery/progress";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

/** Active-phase heartbeat ceiling (~3x of the 45s heartbeat) before we treat disk progress as stale. */
const STALE_ACTIVE_PHASE_MS = 3 * 60 * 1000;

function isAwaitingClientDrainMessage(progress: DiscoveryProgressState): boolean {
  if (progress.phase !== "queueing") return false;
  const m = (progress.message ?? "").toLowerCase();
  return m.includes("queued for deep") || m.includes("continuing in the background");
}

function isCooldownWaitingMessage(progress: DiscoveryProgressState): boolean {
  if (progress.phase !== "queueing") return false;
  const m = (progress.message ?? "").toLowerCase();
  return m.includes("failure retry cooldown");
}

function isStaleActivePhase(progress: DiscoveryProgressState): boolean {
  if (progress.phase !== "analyzing" && progress.phase !== "draining") return false;
  const t = progress.updatedAt ? Date.parse(progress.updatedAt) : NaN;
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > STALE_ACTIVE_PHASE_MS;
}

export async function GET(request: NextRequest) {
  return withActiveUser(request, async () => {
  let progress = await readDiscoveryProgress();

  // Heartbeat stopped while in analyzing/draining (server crash / hung pipeline call):
  // demote to the awaiting-drain message so the client auto-resume picks it up.
  if (isStaleActivePhase(progress)) {
    const [len, actionable] = await Promise.all([
      getEvalQueueLength(),
      getEvalQueueActionableLength(),
    ]);
    if (len === 0) {
      await clearDiscoveryProgress().catch(() => {});
    } else {
      const s = progress.sessionLiveStats ?? defaultSessionLiveStats();
      await setDiscoveryProgress({
        phase: "queueing",
        message:
          actionable === 0
            ? `${len} job(s) remain in the eval queue but are in pipeline failure retry cooldown — nothing runs until the cooldown window passes. Use drain again later or check Ollama logs.`
            : `${len} job(s) queued for deep analysis — continuing in the background…`,
        sessionLiveStats: { ...s, queueRemaining: len },
        step_started_at: new Date().toISOString(),
      });
    }
    progress = await readDiscoveryProgress();
  }

  // Cooldown-waiting message: cooldown window may have elapsed since the message was written.
  // Re-evaluate so the client auto-resume can pick up the row the moment it becomes actionable.
  if (isCooldownWaitingMessage(progress)) {
    const [len, actionable] = await Promise.all([
      getEvalQueueLength(),
      getEvalQueueActionableLength(),
    ]);
    if (len === 0) {
      await clearDiscoveryProgress().catch(() => {});
      progress = await readDiscoveryProgress();
    } else if (actionable > 0) {
      const s = progress.sessionLiveStats ?? defaultSessionLiveStats();
      await setDiscoveryProgress({
        phase: "queueing",
        message: `${len} job(s) queued for deep analysis — continuing in the background…`,
        sessionLiveStats: { ...s, queueRemaining: len },
        step_started_at: new Date().toISOString(),
      });
      progress = await readDiscoveryProgress();
    }
  }

  if (isAwaitingClientDrainMessage(progress)) {
    const len = await getEvalQueueLength();
    if (len === 0) {
      await clearDiscoveryProgress().catch(() => {});
      progress = await readDiscoveryProgress();
    }
  }
  return NextResponse.json(progress, { headers: NO_STORE });
  });
}
