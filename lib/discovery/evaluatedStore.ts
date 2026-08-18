// lib/discovery/evaluatedStore.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getDiscoveryDir, getDiscoveryEvaluatedIdsPath } from "./paths";

export async function loadEvaluatedJobIds(): Promise<Set<string>> {
  try {
    const raw = await readFile(getDiscoveryEvaluatedIdsPath(), "utf-8");
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export async function addEvaluatedJobIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await mkdir(getDiscoveryDir(), { recursive: true });
  const cur = await loadEvaluatedJobIds();
  for (const id of ids) cur.add(id);
  await writeFile(getDiscoveryEvaluatedIdsPath(), JSON.stringify([...cur], null, 2), "utf-8");
}

export async function resetEvaluatedJobIds(): Promise<void> {
  await mkdir(getDiscoveryDir(), { recursive: true });
  await writeFile(getDiscoveryEvaluatedIdsPath(), JSON.stringify([], null, 2), "utf-8");
}

export async function removeEvaluatedJobIds(ids: Iterable<string>): Promise<number> {
  const drop = new Set(ids);
  if (drop.size === 0) return 0;
  const cur = await loadEvaluatedJobIds();
  let n = 0;
  for (const id of drop) {
    if (cur.delete(id)) n += 1;
  }
  if (n === 0) return 0;
  await mkdir(getDiscoveryDir(), { recursive: true });
  await writeFile(getDiscoveryEvaluatedIdsPath(), JSON.stringify([...cur], null, 2), "utf-8");
  return n;
}
