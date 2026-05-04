import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { OLLAMA_MODEL_MAX_LEN, PREFERRED_LOCATION_MAX_CHARS } from "../validation";

const STORAGE_DIR = path.join(process.cwd(), "storage");
const PREFS_PATH = path.join(STORAGE_DIR, "user_preferences.json");

export type UserPreferences = {
  preferred_location: string | null;
  preferred_currency: string | null;
  /** Saved Ollama tag from Dashboard; used when API requests omit `model`. */
  ollama_model: string | null;
};

const DEFAULT_PREFS: UserPreferences = {
  preferred_location: null,
  preferred_currency: null,
  ollama_model: null,
};

export async function loadUserPreferences(): Promise<UserPreferences> {
  try {
    const raw = await readFile(PREFS_PATH, "utf-8");
    const data = JSON.parse(raw) as Partial<UserPreferences>;
    const rawOm = typeof data.ollama_model === "string" ? data.ollama_model.trim() : "";
    return {
      preferred_location:
        typeof data.preferred_location === "string" && data.preferred_location.trim()
          ? data.preferred_location.trim().slice(0, PREFERRED_LOCATION_MAX_CHARS)
          : null,
      preferred_currency:
        typeof data.preferred_currency === "string" && data.preferred_currency.trim()
          ? data.preferred_currency.trim().slice(0, 8).toUpperCase()
          : null,
      ollama_model: rawOm.length > 0 ? rawOm.slice(0, OLLAMA_MODEL_MAX_LEN) : null,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export async function saveUserPreferences(prefs: UserPreferences): Promise<void> {
  await mkdir(STORAGE_DIR, { recursive: true });
  const rawOmSave =
    typeof prefs.ollama_model === "string" && prefs.ollama_model.trim()
      ? prefs.ollama_model.trim().slice(0, OLLAMA_MODEL_MAX_LEN)
      : null;
  const payload: UserPreferences = {
    preferred_location:
      prefs.preferred_location && prefs.preferred_location.trim()
        ? prefs.preferred_location.trim().slice(0, PREFERRED_LOCATION_MAX_CHARS)
        : null,
    preferred_currency:
      prefs.preferred_currency && prefs.preferred_currency.trim()
        ? prefs.preferred_currency.trim().slice(0, 8).toUpperCase()
        : null,
    ollama_model: rawOmSave,
  };
  await writeFile(PREFS_PATH, JSON.stringify(payload, null, 2), "utf-8");
}
