// lib/discovery/discoveryTerminalLog.ts
/** Dev-only milestone lines for the terminal (`ELIZA_DISCOVERY_DEV_LOG=0` to disable). */

export function isDiscoveryTerminalLogEnabled(): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  if (process.env.ELIZA_DISCOVERY_DEV_LOG === "0") return false;
  return true;
}

export function discoveryTerminalLog(message: string): void {
  if (!isDiscoveryTerminalLogEnabled()) return;
  console.info(`[discovery] ${message}`);
}

/** Quarter indices (1-based) for mid-batch terminal progress; skip tiny batches. */
export function discoveryEvalQuarterIndex(idx1Based: number, total: number): boolean {
  if (total < 6) return false;
  const q25 = Math.ceil(total * 0.25);
  const q50 = Math.ceil(total * 0.5);
  const q75 = Math.ceil(total * 0.75);
  return idx1Based === q25 || idx1Based === q50 || idx1Based === q75;
}
