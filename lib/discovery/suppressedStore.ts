// lib/discovery/suppressedStore.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DISCOVERY_DIR, DISCOVERY_SUPPRESSED_IDS_PATH } from "./paths";

type SuppressedFile = { ids: string[] };

export async function loadSuppressedJobIds(): Promise<Set<string>> {
  try {
    const raw = await readFile(DISCOVERY_SUPPRESSED_IDS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as SuppressedFile;
    const ids = Array.isArray(parsed.ids) ? parsed.ids : [];
    return new Set(ids.filter((x): x is string => typeof x === "string" && x.trim().length > 0));
  } catch {
    return new Set();
  }
}

async function saveSuppressedJobIds(ids: Set<string>): Promise<void> {
  await mkdir(DISCOVERY_DIR, { recursive: true });
  await writeFile(DISCOVERY_SUPPRESSED_IDS_PATH, JSON.stringify({ ids: [...ids] } satisfies SuppressedFile, null, 2), "utf-8");
}

export async function addSuppressedJobId(jobId: string): Promise<void> {
  const id = jobId.trim();
  if (!id) return;
  const cur = await loadSuppressedJobIds();
  cur.add(id);
  await saveSuppressedJobIds(cur);
}

