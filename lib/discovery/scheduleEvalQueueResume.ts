// lib/discovery/scheduleEvalQueueResume.ts
/** In-process timer so eval-queue drain continues after Ollama cooldown without a browser tab. */
import { DISCOVERY_FAILURE_COOLDOWN_MS, DISCOVERY_QUEUE_DRAIN_BATCH } from "../../config/constants";
import {
  getUserContext,
  runWithUserContext,
  type UserContext,
} from "../storage/activeUserContext";
import { discoveryTerminalLog } from "./discoveryTerminalLog";
import { msUntilNextFailureCooldownEnd } from "./evalFailureStore";
import { getEvalQueueActionableLength, getEvalQueueLength } from "./evalQueue";
import {
  isDiscoverySyncLocked,
  markDiscoveryAwaitingDrain,
  withDiscoverySyncLock,
} from "./lock";
import {
  defaultSessionLiveStats,
  progressSyncFinished,
  readDiscoveryProgress,
  setDiscoveryProgress,
} from "./progress";

const LOCK_RETRY_MS = 15_000;
const CONTINUE_DRAIN_MS = 2_000;
const COOLDOWN_BUFFER_MS = 1_500;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export type EvalQueueResumeOpts = {
  model: string;
  preferred_location?: string | null;
  queueRemaining: number;
  actionableRemaining: number;
};

function cancelResumeTimer(userId: string): void {
  const prev = timers.get(userId);
  if (prev) clearTimeout(prev);
  timers.delete(userId);
}

function armResumeTimer(userId: string, delayMs: number, fire: () => void): void {
  cancelResumeTimer(userId);
  timers.set(
    userId,
    setTimeout(() => {
      timers.delete(userId);
      fire();
    }, delayMs),
  );
}

async function drainOneRound(
  ctx: UserContext,
  model: string,
  preferred_location: string | null | undefined,
): Promise<void> {
  const { processEvalQueue } = await import("./processEvalQueue");
  await runWithUserContext(ctx, async () => {
    if (isDiscoverySyncLocked()) {
      discoveryTerminalLog("phase=server_drain deferred reason=locked");
      armResumeTimer(ctx.userId, LOCK_RETRY_MS, () => {
        void drainOneRound(ctx, model, preferred_location);
      });
      return;
    }

    try {
      await withDiscoverySyncLock(async () => {
        const actionable = await getEvalQueueActionableLength();
        if (actionable === 0) {
          const q = await getEvalQueueLength();
          if (q === 0) {
            markDiscoveryAwaitingDrain(false);
            const prev = await readDiscoveryProgress();
            const s = prev.sessionLiveStats ?? defaultSessionLiveStats();
            await progressSyncFinished({
              jobsAdded: s.newJobsAdded,
              jobsEvaluated: s.jobsEvaluated,
              highMatches: s.newHighMatches,
            }).catch(() => {});
            return;
          }
          await scheduleEvalQueueResumeIfNeeded({
            model,
            preferred_location,
            queueRemaining: q,
            actionableRemaining: 0,
          });
          return;
        }

        const result = await processEvalQueue({
          model,
          maxItems: DISCOVERY_QUEUE_DRAIN_BATCH,
          draining: true,
          ...(preferred_location !== undefined ? { preferred_location } : {}),
        });

        if (result.queue_remaining === 0) {
          markDiscoveryAwaitingDrain(false);
          const prev = await readDiscoveryProgress();
          const s = prev.sessionLiveStats ?? defaultSessionLiveStats();
          await progressSyncFinished({
            jobsAdded: s.newJobsAdded,
            jobsEvaluated: s.jobsEvaluated + (result.jobs_evaluated ?? 0),
            highMatches: s.newHighMatches + (result.new_high_matches ?? 0),
          }).catch(() => {});
          return;
        }

        markDiscoveryAwaitingDrain(true);
        const prev = await readDiscoveryProgress();
        const s = prev.sessionLiveStats ?? defaultSessionLiveStats();
        await setDiscoveryProgress({
          sessionLiveStats: {
            ...s,
            jobsEvaluated: s.jobsEvaluated + (result.jobs_evaluated ?? 0),
            newHighMatches: s.newHighMatches + (result.new_high_matches ?? 0),
            queueRemaining: result.queue_remaining,
          },
        });
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "DISCOVERY_LOCKED") {
        armResumeTimer(ctx.userId, LOCK_RETRY_MS, () => {
          void drainOneRound(ctx, model, preferred_location);
        });
        return;
      }
      console.error("[discovery] server drain failed", msg);
    }
  });
}

/**
 * After a batch: keep draining if work remains, or wait out failure cooldown.
 * No-op without user context or when `ELIZA_DISCOVERY_SERVER_DRAIN=0`.
 */
export async function scheduleEvalQueueResumeIfNeeded(opts: EvalQueueResumeOpts): Promise<void> {
  const ctx = getUserContext();
  if (!ctx) return;
  if (process.env.ELIZA_DISCOVERY_SERVER_DRAIN === "0") return;

  if (opts.queueRemaining <= 0) {
    cancelResumeTimer(ctx.userId);
    return;
  }

  let delayMs = CONTINUE_DRAIN_MS;
  if (opts.actionableRemaining === 0) {
    const wait = await msUntilNextFailureCooldownEnd();
    if (wait === null) return;
    delayMs = Math.min(
      DISCOVERY_FAILURE_COOLDOWN_MS + 5_000,
      Math.max(CONTINUE_DRAIN_MS, wait + COOLDOWN_BUFFER_MS),
    );
  }

  discoveryTerminalLog(
    `phase=server_drain_scheduled delay_ms=${delayMs} queue=${opts.queueRemaining} actionable=${opts.actionableRemaining}`,
  );
  armResumeTimer(ctx.userId, delayMs, () => {
    void drainOneRound(ctx, opts.model, opts.preferred_location);
  });
}
