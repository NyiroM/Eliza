import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CV_SKILL_SUGGEST_LIMITS } from "../../config/constants";
import type { CvParseResult } from "../parsers/cvParser";
import { requireUserContext } from "../storage/activeUserContext";

function cacheDirForActiveUser(): string {
  const { userId } = requireUserContext();
  return path.join(process.cwd(), ".cache", "cv_parses", userId);
}
/** Bust cache when parser contract or normalisation changes meaningfully. */
const CV_PARSE_CACHE_VERSION = "v0.4.0";

export type CvParseCacheEntry = {
  cache_version: string;
  model: string;
  raw_sha256: string;
  source_filename: string | null;
  parsed: CvParseResult;
};

export function getCvParseCacheKey(rawText: string, model: string): string {
  const h = createHash("sha256");
  h.update(CV_PARSE_CACHE_VERSION);
  h.update("\0");
  h.update(model.trim().toLowerCase());
  h.update("\0");
  h.update(rawText);
  return h.digest("hex");
}

function cacheFilePath(key: string): string {
  return path.join(cacheDirForActiveUser(), `${key}.json`);
}

export async function readCvParseCache(
  key: string,
  rawText: string,
  model: string,
): Promise<CvParseResult | null> {
  const raw_sha256 = createHash("sha256").update(rawText).digest("hex");
  const modelNorm = model.trim().toLowerCase();
  try {
    const raw = await readFile(cacheFilePath(key), "utf-8");
    const entry = JSON.parse(raw) as CvParseCacheEntry;
    if (entry.cache_version !== CV_PARSE_CACHE_VERSION) return null;
    if (entry.model.trim().toLowerCase() !== modelNorm) return null;
    if (entry.raw_sha256 !== raw_sha256) return null;
    if (!entry.parsed || typeof entry.parsed !== "object") return null;
    return entry.parsed;
  } catch {
    return null;
  }
}

export async function writeCvParseCache(
  key: string,
  rawText: string,
  model: string,
  parsed: CvParseResult,
  sourceFilename: string | null,
): Promise<void> {
  await mkdir(cacheDirForActiveUser(), { recursive: true });
  const entry: CvParseCacheEntry = {
    cache_version: CV_PARSE_CACHE_VERSION,
    model: model.trim(),
    raw_sha256: createHash("sha256").update(rawText).digest("hex"),
    source_filename: sourceFilename?.trim() || null,
    parsed,
  };
  await writeFile(cacheFilePath(key), JSON.stringify(entry, null, 2), "utf-8");
}

/**
 * If a cache entry exists for this key, replace only `parsed.skills` so pipeline and disk stay aligned
 * after the user edits the CV skill list.
 */
export async function patchCvParseCacheSkillsIfExists(
  key: string,
  rawText: string,
  model: string,
  skills: string[],
): Promise<boolean> {
  const raw_sha256 = createHash("sha256").update(rawText).digest("hex");
  const modelNorm = model.trim().toLowerCase();
  const fp = cacheFilePath(key);
  let raw: string;
  try {
    raw = await readFile(fp, "utf-8");
  } catch {
    return false;
  }
  let entry: CvParseCacheEntry;
  try {
    entry = JSON.parse(raw) as CvParseCacheEntry;
  } catch {
    return false;
  }
  if (entry.cache_version !== CV_PARSE_CACHE_VERSION) return false;
  if (entry.model.trim().toLowerCase() !== modelNorm) return false;
  if (entry.raw_sha256 !== raw_sha256) return false;
  if (!entry.parsed || typeof entry.parsed !== "object") return false;

  const capped = skills
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, CV_SKILL_SUGGEST_LIMITS.maxSkillsStored);
  const next: CvParseCacheEntry = {
    ...entry,
    parsed: {
      ...entry.parsed,
      skills: capped,
    },
  };
  await writeFile(fp, JSON.stringify(next, null, 2), "utf-8");
  return true;
}

export function formatCvCacheLabel(sourceFilename: string | null, key: string): string {
  if (sourceFilename?.trim()) return sourceFilename.trim();
  return `CV (${key.slice(0, 8)}…)`;
}
