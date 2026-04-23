import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PREFERRED_LOCATION_MAX_CHARS } from "../validation";

const STORAGE_DIR = path.join(process.cwd(), "storage");
const PREFS_PATH = path.join(STORAGE_DIR, "user_preferences.json");

export type UserPreferences = {
  preferred_location: string | null;
  preferred_currency: string | null;
};

const DEFAULT_PREFS: UserPreferences = {
  preferred_location: null,
  preferred_currency: null,
};

export async function loadUserPreferences(): Promise<UserPreferences> {
  try {
    const raw = await readFile(PREFS_PATH, "utf-8");
    const data = JSON.parse(raw) as Partial<UserPreferences>;
    return {
      preferred_location:
        typeof data.preferred_location === "string" && data.preferred_location.trim()
          ? data.preferred_location.trim().slice(0, PREFERRED_LOCATION_MAX_CHARS)
          : null,
      preferred_currency:
        typeof data.preferred_currency === "string" && data.preferred_currency.trim()
          ? data.preferred_currency.trim().slice(0, 8).toUpperCase()
          : null,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export async function saveUserPreferences(prefs: UserPreferences): Promise<void> {
  await mkdir(STORAGE_DIR, { recursive: true });
  const payload: UserPreferences = {
    preferred_location:
      prefs.preferred_location && prefs.preferred_location.trim()
        ? prefs.preferred_location.trim().slice(0, PREFERRED_LOCATION_MAX_CHARS)
        : null,
    preferred_currency:
      prefs.preferred_currency && prefs.preferred_currency.trim()
        ? prefs.preferred_currency.trim().slice(0, 8).toUpperCase()
        : null,
  };
  await writeFile(PREFS_PATH, JSON.stringify(payload, null, 2), "utf-8");
}
