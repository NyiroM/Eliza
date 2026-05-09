// lib/discovery/evaluatedStore.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DISCOVERY_DIR, DISCOVERY_EVALUATED_IDS_PATH } from "./paths";

export async function loadEvaluatedJobIds(): Promise<Set<string>> {
  try {
    const raw = await readFile(DISCOVERY_EVALUATED_IDS_PATH, "utf-8");
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export async function addEvaluatedJobIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await mkdir(DISCOVERY_DIR, { recursive: true });
  const cur = await loadEvaluatedJobIds();
  for (const id of ids) cur.add(id);
  await writeFile(DISCOVERY_EVALUATED_IDS_PATH, JSON.stringify([...cur], null, 2), "utf-8");
}

export async function resetEvaluatedJobIds(): Promise<void> {
  await mkdir(DISCOVERY_DIR, { recursive: true });
  await writeFile(DISCOVERY_EVALUATED_IDS_PATH, JSON.stringify([], null, 2), "utf-8");
}
