// lib/discovery/evalFailureStore.ts
// Bounded retry store for jobs whose pipeline run failed transiently. Separate from
// evaluated_ids.json so a Ollama hiccup does not silently drop a posting forever.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DISCOVERY_FAILURE_COOLDOWN_MS } from "../../config/constants";
import { getDiscoveryDir, getDiscoveryEvalFailuresPath } from "./paths";

export type EvalFailureRow = {
  id: string;
  attempts: number;
  last_error: string;
  last_error_at: string;
};

type FileShape = { items: EvalFailureRow[] };

async function loadFile(): Promise<EvalFailureRow[]> {
  try {
    const raw = await readFile(getDiscoveryEvalFailuresPath(), "utf-8");
    const parsed = JSON.parse(raw) as FileShape;
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

async function saveFile(items: EvalFailureRow[]): Promise<void> {
  await mkdir(getDiscoveryDir(), { recursive: true });
  const data: FileShape = { items };
  await writeFile(getDiscoveryEvalFailuresPath(), JSON.stringify(data, null, 2), "utf-8");
}

export async function loadEvalFailureMap(): Promise<Map<string, EvalFailureRow>> {
  const items = await loadFile();
  const map = new Map<string, EvalFailureRow>();
  for (const row of items) map.set(row.id, row);
  return map;
}

/** Increment attempts and persist. Returns the new attempts count. */
export async function recordEvalFailure(id: string, msg: string): Promise<number> {
  const items = await loadFile();
  const idx = items.findIndex((r) => r.id === id);
  const now = new Date().toISOString();
  const trimmed = msg.length > 400 ? `${msg.slice(0, 397)}...` : msg;
  if (idx >= 0) {
    const next: EvalFailureRow = {
      id,
      attempts: items[idx].attempts + 1,
      last_error: trimmed,
      last_error_at: now,
    };
    items[idx] = next;
    await saveFile(items);
    return next.attempts;
  }
  items.push({ id, attempts: 1, last_error: trimmed, last_error_at: now });
  await saveFile(items);
  return 1;
}

export async function clearEvalFailure(id: string): Promise<void> {
  const items = await loadFile();
  const next = items.filter((r) => r.id !== id);
  if (next.length !== items.length) await saveFile(next);
}

/** True when the failure row is fresh enough that we should not retry yet. */
export function isFailureInCooldown(row: EvalFailureRow, now: number = Date.now()): boolean {
  if (DISCOVERY_FAILURE_COOLDOWN_MS <= 0) return false;
  const ts = Date.parse(row.last_error_at);
  if (!Number.isFinite(ts)) return false;
  return now - ts < DISCOVERY_FAILURE_COOLDOWN_MS;
}

/**
 * ms until the soonest `eval_failures` cooldown ends.
 * `0` = at least one row is already due; `null` = no failure rows.
 */
export async function msUntilNextFailureCooldownEnd(now: number = Date.now()): Promise<number | null> {
  if (DISCOVERY_FAILURE_COOLDOWN_MS <= 0) return 0;
  const items = await loadFile();
  if (items.length === 0) return null;
  let soonest: number | null = null;
  for (const row of items) {
    const ts = Date.parse(row.last_error_at);
    if (!Number.isFinite(ts)) continue;
    const remaining = ts + DISCOVERY_FAILURE_COOLDOWN_MS - now;
    const clamped = remaining <= 0 ? 0 : remaining;
    if (soonest === null || clamped < soonest) soonest = clamped;
  }
  return soonest;
}

/** Remove failure rows for ids the caller has marked as definitively evaluated. */
export async function pruneEvalFailures(ids: ReadonlySet<string>): Promise<void> {
  if (ids.size === 0) return;
  const items = await loadFile();
  const next = items.filter((r) => !ids.has(r.id));
  if (next.length !== items.length) await saveFile(next);
}
