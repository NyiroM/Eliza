// lib/storage/resolveOllamaModel.ts
/** Resolves Ollama model tag: explicit request body wins, else saved user preference, else app default. */
import { DEFAULT_OLLAMA_MODEL } from "../../config/constants";
import { validateOllamaModelTag } from "../validation";
import { loadUserPreferences } from "./userPreferences";

export async function resolveOllamaModel(explicit: unknown): Promise<string> {
  if (typeof explicit === "string" && explicit.trim()) {
    const v = validateOllamaModelTag(explicit.trim());
    if (v.ok) return v.model;
  }
  const prefs = await loadUserPreferences();
  const stored = typeof prefs.ollama_model === "string" ? prefs.ollama_model.trim() : "";
  if (stored) {
    const v = validateOllamaModelTag(stored);
    if (v.ok) return v.model;
  }
  return DEFAULT_OLLAMA_MODEL;
}
