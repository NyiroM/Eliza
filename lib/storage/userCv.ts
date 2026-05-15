import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CV_SKILL_SUGGEST_LIMITS, DEFAULT_OLLAMA_MODEL } from "../../config/constants";
import {
  getCvParseCacheKey,
  patchCvParseCacheSkillsIfExists,
} from "../cache/cvParseCache";
import { parseCvPdfBuffer, parseCvText, type CvParseResult } from "../parsers/cvParser";
import { requireUserRoot } from "./activeUserContext";

function userCvPath(): string {
  return path.join(requireUserRoot(), "user_cv.json");
}

/** Pending AI skill phrase (Discovery-style); only `suggested` rows are persisted. */
export type CvSkillSuggestionRow = {
  phrase: string;
  status: "suggested";
};

export type StoredCvPayload = {
  raw_text: string;
  parsed: CvParseResult;
  uploaded_at: string;
  /** Original upload filename for cache logging (optional). */
  source_filename?: string | null;
  /** AI-generated skill phrases awaiting user approval. */
  skill_suggestions?: CvSkillSuggestionRow[];
};

export async function saveParsedCvToStorage(payload: StoredCvPayload): Promise<void> {
  const p = userCvPath();
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(payload, null, 2), "utf-8");
}

export async function loadStoredCvFromStorage(): Promise<StoredCvPayload | null> {
  try {
    const content = await readFile(userCvPath(), "utf-8");
    return JSON.parse(content) as StoredCvPayload;
  } catch {
    return null;
  }
}

export async function parseAndStoreCvFromPdfBuffer(
  pdfBuffer: Buffer,
  ollamaModel = DEFAULT_OLLAMA_MODEL,
  sourceFilename?: string | null,
): Promise<StoredCvPayload> {
  const rawText = await parseCvPdfBuffer(pdfBuffer);
  const parsed = await parseCvText(rawText, ollamaModel);
  const payload: StoredCvPayload = {
    raw_text: rawText,
    parsed,
    uploaded_at: new Date().toISOString(),
    skill_suggestions: [],
    ...(sourceFilename != null && sourceFilename.trim()
      ? { source_filename: sourceFilename.trim() }
      : {}),
  };
  await saveParsedCvToStorage(payload);
  return payload;
}

export async function hasStoredCv(): Promise<boolean> {
  const data = await loadStoredCvFromStorage();
  return data !== null;
}

function normalizeSkillPhrase(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, CV_SKILL_SUGGEST_LIMITS.maxPhraseChars);
}

/** Dedupe trimmed skills; preserve first-seen casing; cap length. */
export function dedupeSkillsList(skills: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of skills) {
    const t = s.trim();
    if (!t) continue;
    const capped = t.slice(0, CV_SKILL_SUGGEST_LIMITS.maxPhraseChars);
    const k = capped.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(capped);
    if (out.length >= CV_SKILL_SUGGEST_LIMITS.maxSkillsStored) break;
  }
  return out;
}

export function parseCommaSeparatedSkills(text: string): string[] {
  const parts = text.split(/[,;\n\r]+/);
  const raw: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (t) raw.push(t);
  }
  return dedupeSkillsList(raw);
}

export async function syncCvParseCacheSkillsFromDisk(
  stored: StoredCvPayload,
  model: string,
  skills: string[],
): Promise<boolean> {
  const key = getCvParseCacheKey(stored.raw_text ?? "", model);
  return patchCvParseCacheSkillsIfExists(key, stored.raw_text ?? "", model, skills);
}

function parseSkillSuggestions(raw: unknown): CvSkillSuggestionRow[] {
  if (!Array.isArray(raw)) return [];
  const out: CvSkillSuggestionRow[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const o = row as { phrase?: unknown; status?: unknown };
    const phrase = typeof o.phrase === "string" ? normalizeSkillPhrase(o.phrase) : "";
    if (!phrase) continue;
    if (o.status !== "suggested") continue;
    out.push({ phrase, status: "suggested" });
  }
  return out.slice(0, CV_SKILL_SUGGEST_LIMITS.maxPendingStored);
}

export function getSanitizedSkillSuggestions(stored: StoredCvPayload): CvSkillSuggestionRow[] {
  return parseSkillSuggestions(stored.skill_suggestions);
}

/**
 * Replace CV `parsed.skills`, optionally sync parse cache, persist.
 * Returns updated payload or null if no CV on disk.
 */
export async function replaceParsedSkillsInStorage(
  skills: string[],
  modelForCache: string,
): Promise<StoredCvPayload | null> {
  const stored = await loadStoredCvFromStorage();
  if (!stored) return null;
  const nextSkills = dedupeSkillsList(skills);
  const nextParsed: CvParseResult = { ...stored.parsed, skills: nextSkills };
  const next: StoredCvPayload = {
    ...stored,
    parsed: nextParsed,
    skill_suggestions: filterSuggestionsAgainstSkills(
      getSanitizedSkillSuggestions(stored),
      nextSkills,
    ),
  };
  await saveParsedCvToStorage(next);
  await syncCvParseCacheSkillsFromDisk(next, modelForCache, nextSkills);
  return next;
}

function filterSuggestionsAgainstSkills(
  pending: CvSkillSuggestionRow[],
  skills: readonly string[],
): CvSkillSuggestionRow[] {
  const skillLower = new Set(skills.map((s) => s.trim().toLowerCase()).filter(Boolean));
  return pending.filter((p) => !skillLower.has(p.phrase.toLowerCase()));
}

export async function appendPendingCvSkillSuggestions(
  phrases: readonly string[],
  currentSkills: readonly string[],
): Promise<{ stored: StoredCvPayload; added: number }> {
  const stored = await loadStoredCvFromStorage();
  if (!stored) throw new Error("No stored CV");
  const skillLower = new Set(currentSkills.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const existing = getSanitizedSkillSuggestions(stored);
  const seenPhrase = new Set(existing.map((r) => r.phrase.toLowerCase()));
  for (const s of currentSkills) seenPhrase.add(s.trim().toLowerCase());

  let added = 0;
  const next = [...existing];
  for (const raw of phrases) {
    const phrase = normalizeSkillPhrase(raw);
    if (!phrase) continue;
    const low = phrase.toLowerCase();
    if (skillLower.has(low) || seenPhrase.has(low)) continue;
    seenPhrase.add(low);
    next.push({ phrase, status: "suggested" });
    added += 1;
    if (next.length >= CV_SKILL_SUGGEST_LIMITS.maxPendingStored) break;
  }

  const merged: StoredCvPayload = { ...stored, skill_suggestions: next };
  await saveParsedCvToStorage(merged);
  return { stored: merged, added };
}

export async function approveCvSkillSuggestionPhrase(
  phrase: string,
  modelForCache: string,
): Promise<{ stored: StoredCvPayload; approved: boolean } | null> {
  const stored = await loadStoredCvFromStorage();
  if (!stored) return null;
  const target = normalizeSkillPhrase(phrase);
  if (!target) return { stored, approved: false };
  const pending = getSanitizedSkillSuggestions(stored);
  const idx = pending.findIndex((p) => p.phrase.toLowerCase() === target.toLowerCase());
  if (idx < 0) return { stored, approved: false };

  const skills = dedupeSkillsList([...(stored.parsed.skills ?? []), pending[idx].phrase]);
  const rest = pending.filter((_, i) => i !== idx);
  const next: StoredCvPayload = {
    ...stored,
    parsed: { ...stored.parsed, skills },
    skill_suggestions: rest,
  };
  await saveParsedCvToStorage(next);
  await syncCvParseCacheSkillsFromDisk(next, modelForCache, skills);
  return { stored: next, approved: true };
}

export async function rejectCvSkillSuggestionPhrase(phrase: string): Promise<StoredCvPayload | null> {
  const stored = await loadStoredCvFromStorage();
  if (!stored) return null;
  const target = normalizeSkillPhrase(phrase);
  if (!target) return stored;
  const pending = getSanitizedSkillSuggestions(stored);
  const rest = pending.filter((p) => p.phrase.toLowerCase() !== target.toLowerCase());
  if (rest.length === pending.length) return stored;
  const next: StoredCvPayload = { ...stored, skill_suggestions: rest };
  await saveParsedCvToStorage(next);
  return next;
}

export async function clearPendingCvSkillSuggestions(): Promise<StoredCvPayload | null> {
  const stored = await loadStoredCvFromStorage();
  if (!stored) return null;
  if ((stored.skill_suggestions ?? []).length === 0) return stored;
  const next: StoredCvPayload = { ...stored, skill_suggestions: [] };
  await saveParsedCvToStorage(next);
  return next;
}

export async function approveAllPendingCvSkillSuggestions(
  modelForCache: string,
): Promise<StoredCvPayload | null> {
  const stored = await loadStoredCvFromStorage();
  if (!stored) return null;
  const pending = getSanitizedSkillSuggestions(stored);
  if (pending.length === 0) return stored;
  const merged = dedupeSkillsList([
    ...(stored.parsed.skills ?? []),
    ...pending.map((p) => p.phrase),
  ]);
  return replaceParsedSkillsInStorage(merged, modelForCache);
}

/** Removes the first CV skill entry equal to `skillToRemove` (trimmed, case-insensitive). */
export async function removeSkillFromStoredCv(
  skillToRemove: string,
  modelForCache: string,
): Promise<string[] | null> {
  const needle = skillToRemove.trim().toLowerCase();
  if (!needle) return null;
  const stored = await loadStoredCvFromStorage();
  if (!stored) return null;
  const skills = stored.parsed.skills ?? [];
  const idx = skills.findIndex((s) => s.trim().toLowerCase() === needle);
  if (idx < 0) return skills;
  const nextSkills = skills.filter((_, i) => i !== idx);
  const nextParsed = { ...stored.parsed, skills: nextSkills };
  const next: StoredCvPayload = {
    ...stored,
    parsed: nextParsed,
    skill_suggestions: filterSuggestionsAgainstSkills(getSanitizedSkillSuggestions(stored), nextSkills),
  };
  await saveParsedCvToStorage(next);
  await syncCvParseCacheSkillsFromDisk(next, modelForCache, nextSkills);
  return nextSkills;
}
