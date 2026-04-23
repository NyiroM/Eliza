import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const STORAGE_DIR = path.join(process.cwd(), "storage");
const USER_CORRECTIONS_PATH = path.join(STORAGE_DIR, "user_corrections.json");

export type UserCorrectionEntry = {
  text: string;
  created_at: string;
};

export type StoredUserCorrections = {
  corrections: UserCorrectionEntry[];
  updated_at: string;
};

const EMPTY: StoredUserCorrections = {
  corrections: [],
  updated_at: new Date(0).toISOString(),
};

export async function loadUserCorrectionsFromStorage(): Promise<StoredUserCorrections> {
  try {
    const content = await readFile(USER_CORRECTIONS_PATH, "utf-8");
    const parsed = JSON.parse(content) as Partial<StoredUserCorrections>;
    const corrections = Array.isArray(parsed.corrections)
      ? parsed.corrections
          .map((c) => {
            if (!c || typeof c !== "object") return null;
            const r = c as Record<string, unknown>;
            const text = typeof r.text === "string" ? r.text.trim() : "";
            if (!text) return null;
            return {
              text,
              created_at:
                typeof r.created_at === "string" ? r.created_at : new Date().toISOString(),
            } satisfies UserCorrectionEntry;
          })
          .filter((c): c is UserCorrectionEntry => c !== null)
      : [];
    return {
      corrections,
      updated_at:
        typeof parsed.updated_at === "string" ? parsed.updated_at : new Date().toISOString(),
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Block for LLM system append — empty string if none. */
export async function loadUserCorrectionsPromptBlock(): Promise<string> {
  const { corrections } = await loadUserCorrectionsFromStorage();
  if (corrections.length === 0) return "";
  const lines = corrections.map((c, i) => `${i + 1}. ${c.text}`);
  return lines.join("\n");
}

export async function appendUserCorrection(text: string): Promise<StoredUserCorrections> {
  const trimmed = text.trim();
  if (!trimmed) {
    return loadUserCorrectionsFromStorage();
  }
  const prev = await loadUserCorrectionsFromStorage();
  const next: StoredUserCorrections = {
    corrections: [
      ...prev.corrections,
      { text: trimmed, created_at: new Date().toISOString() },
    ],
    updated_at: new Date().toISOString(),
  };
  await mkdir(STORAGE_DIR, { recursive: true });
  await writeFile(USER_CORRECTIONS_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}
