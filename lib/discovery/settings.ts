// lib/discovery/settings.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type {
  DiscoveryProviderId,
  DiscoveryProviderState,
  DiscoverySettings,
} from "../../types/discovery";
import { DISCOVERY_DIR, DISCOVERY_SETTINGS_PATH } from "./paths";
import { migrateApprovedSuggestionsIntoSearchKeywords, sanitizeKeywordSuggestions } from "./keywordSync";

const DEFAULT_PROVIDER: DiscoveryProviderState = {
  auto: false,
  last_run_at: null,
  last_jobs_found: 0,
  last_jobs_new_to_catalog: 0,
  last_error: null,
  last_search_hint: null,
};

export function defaultDiscoverySettings(): DiscoverySettings {
  return {
    auto_sync_interval_minutes: 60,
    match_notify_threshold_percent: 70,
    search_keywords: "software developer",
    keyword_suggestions: [],
    providers: {
      indeed: { ...DEFAULT_PROVIDER },
      linkedin: { ...DEFAULT_PROVIDER },
      profession: { ...DEFAULT_PROVIDER },
    },
  };
}

export async function loadDiscoverySettings(): Promise<DiscoverySettings> {
  try {
    const raw = await readFile(DISCOVERY_SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DiscoverySettings>;
    const base = defaultDiscoverySettings();
    const mergedProviders = { ...base.providers, ...(parsed.providers ?? {}) };
    for (const id of ["indeed", "linkedin", "profession"] as const) {
      mergedProviders[id] = { ...base.providers[id], ...mergedProviders[id] };
    }
    return migrateApprovedSuggestionsIntoSearchKeywords({
      ...base,
      ...parsed,
      keyword_suggestions: sanitizeKeywordSuggestions(parsed.keyword_suggestions ?? base.keyword_suggestions),
      providers: mergedProviders,
    });
  } catch {
    return defaultDiscoverySettings();
  }
}

export async function saveDiscoverySettings(settings: DiscoverySettings): Promise<void> {
  await mkdir(DISCOVERY_DIR, { recursive: true });
  await writeFile(DISCOVERY_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
}

export function patchProviderState(
  settings: DiscoverySettings,
  id: DiscoveryProviderId,
  patch: Partial<DiscoveryProviderState>,
): DiscoverySettings {
  return {
    ...settings,
    providers: {
      ...settings.providers,
      [id]: { ...settings.providers[id], ...patch },
    },
  };
}
