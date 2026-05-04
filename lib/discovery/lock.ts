// lib/discovery/lock.ts
/** In-process mutex so only one discovery sync or process-queue body runs at a time. */

let discoverySyncLocked = false;

/** Blocks new syncs until the eval queue is fully drained (or TTL elapses). */
let discoveryAwaitingDrainDeadline = 0;

const DRAIN_SESSION_TTL_MS = 10 * 60 * 1000;

export function isDiscoverySyncLocked(): boolean {
  return discoverySyncLocked;
}

/**
 * True when a prior sync left jobs in the eval queue and the client must finish
 * POST /api/discovery/process-queue until empty. New sync returns 409 while this holds.
 */
export function isDiscoverySessionBlockingSync(): boolean {
  if (discoveryAwaitingDrainDeadline <= 0) return false;
  if (Date.now() >= discoveryAwaitingDrainDeadline) {
    discoveryAwaitingDrainDeadline = 0;
    return false;
  }
  return true;
}

/** Call from /api/discovery/sync after a successful run when queue_remaining > 0. */
export function markDiscoveryAwaitingDrain(active: boolean): void {
  if (active) {
    discoveryAwaitingDrainDeadline = Date.now() + DRAIN_SESSION_TTL_MS;
  } else {
    discoveryAwaitingDrainDeadline = 0;
  }
}

export async function withDiscoverySyncLock<T>(fn: () => Promise<T>): Promise<T> {
  if (discoverySyncLocked) {
    throw new Error("DISCOVERY_LOCKED");
  }
  discoverySyncLocked = true;
  try {
    return await fn();
  } finally {
    discoverySyncLocked = false;
  }
}
