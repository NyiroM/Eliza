// lib/pipeline/locationGeographyVeto.ts — deterministic dashboard geography vs job location (AI may also veto).

import {
  firstCommaLocationSegment,
  JOB_BOARD_BROAD_LOCATION_SLUGS,
  segmentToLocationSlug,
} from "../discovery/locationPreferenceShared";
import type { StoredConstraintTactics } from "../storage/constraintTactics";

export type OfflineVetoResult = {
  vetoed: boolean;
  veto_reason: string | null;
  /** Short user-facing headline when vetoed (e.g. location clash). */
  user_message?: string | null;
};

export type LocationGeographyVetoInput = {
  preferredLocation: string | null;
  jobLocation: string | null;
  jobTextEnglish: string;
  combinedJobText?: string;
  workModel?: string | null;
  tactics: StoredConstraintTactics;
};

function stanceFor(tactics: StoredConstraintTactics): "default" | "strong_preference" {
  return tactics.tactics.location ?? "default";
}

/** Known city slugs for token scan (HU + common EU hubs). */
const KNOWN_CITY_SLUGS = new Set([
  "budapest",
  "miskolc",
  "debrecen",
  "szeged",
  "gyor",
  "pecs",
  "kecskemet",
  "szekesfehervar",
  "nyiregyhaza",
  "szombathely",
  "szolnok",
  "tatabanya",
  "erd",
  "szigetszentmiklos",
  "dunakeszi",
  "godollo",
  "vac",
  "zalaegerszeg",
  "sopron",
  "eger",
  "bekescsaba",
  "kaposvar",
  "veszprem",
  "berlin",
  "munich",
  "munchen",
  "hamburg",
  "frankfurt",
  "vienna",
  "wien",
  "prague",
  "praha",
  "warsaw",
  "warszawa",
  "krakow",
  "bucharest",
  "bucuresti",
  "london",
  "manchester",
  "birmingham",
  "paris",
  "lyon",
  "marseille",
  "amsterdam",
  "rotterdam",
  "brussels",
  "bruxelles",
  "zurich",
  "geneva",
  "genf",
]);

/** Commuter / same-metro synonyms keyed by user primary slug. */
const METRO_BY_PRIMARY: Record<string, readonly string[]> = {
  budapest: [
    "budapest",
    "pest",
    "buda",
    "szigetszentmiklos",
    "dunakeszi",
    "godollo",
    "erd",
    "vac",
    "szentendre",
    "budaors",
    "cegled",
  ],
};

function isCityLikeSlug(slug: string): boolean {
  return slug.length >= 3 && !JOB_BOARD_BROAD_LOCATION_SLUGS.has(slug);
}

function metroSlugsForUserPrimary(primarySlug: string): Set<string> {
  const extra = METRO_BY_PRIMARY[primarySlug];
  if (extra) return new Set(extra);
  return new Set([primarySlug]);
}

function collectKnownCitySlugsFromText(text: string): Set<string> {
  const out = new Set<string>();
  const norm = text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  for (const city of KNOWN_CITY_SLUGS) {
    const pattern = city.replace(/-/g, "[-\\s]?");
    if (new RegExp(`\\b${pattern}\\b`, "i").test(norm)) out.add(city);
  }
  return out;
}

function extractJobUrlFromBlob(blob: string): string | null {
  const m = blob.match(/\bURL:\s*(https?:\/\/\S+)/i);
  return m?.[1]?.replace(/[)\]>.,;]+$/, "") ?? null;
}

/** Profession.hu /allas/{slug-with-city-before-numeric-id} */
function collectCitySlugsFromProfessionUrl(url: string): Set<string> {
  const out = new Set<string>();
  try {
    const u = new URL(url);
    if (!u.hostname.replace(/^www\./, "").includes("profession.hu")) return out;
    const pathSlug = u.pathname.match(/\/allas\/([^/]+)/i)?.[1] ?? "";
    const parts = pathSlug.toLowerCase().split("-").filter(Boolean);
    for (const part of parts) {
      if (KNOWN_CITY_SLUGS.has(part)) out.add(part);
    }
    const tail = parts[parts.length - 1];
    if (tail && /^\d+$/.test(tail) && parts.length >= 2) {
      const beforeId = parts[parts.length - 2];
      if (KNOWN_CITY_SLUGS.has(beforeId)) out.add(beforeId);
    }
  } catch {
    /* ignore */
  }
  return out;
}

function primarySlugFromJobLocationField(jobLocation: string | null): string | null {
  if (!jobLocation?.trim()) return null;
  const first = jobLocation.split(/[,;|/–—]/)[0]?.trim() ?? "";
  if (!first) return null;
  const slug = segmentToLocationSlug(first);
  return slug && isCityLikeSlug(slug) ? slug : null;
}

function collectJobCitySlugs(
  jobLocation: string | null,
  jobTextEnglish: string,
  combinedJobText: string,
): Set<string> {
  const blob = `${jobLocation ?? ""}\n${jobTextEnglish}\n${combinedJobText}`;
  const out = collectKnownCitySlugsFromText(blob);
  const fromField = primarySlugFromJobLocationField(jobLocation);
  if (fromField) out.add(fromField);
  const url = extractJobUrlFromBlob(blob);
  if (url) {
    for (const s of collectCitySlugsFromProfessionUrl(url)) out.add(s);
  }
  return out;
}

function isRemoteWithoutResidenceConflict(workModel: string | null, blob: string): boolean {
  const wm = (workModel ?? "").toLowerCase();
  const remote =
    /\bremote\b/.test(wm) ||
    /\b(fully|100%)\s+remote\b/i.test(blob) ||
    /\bwork\s+from\s+home\b/i.test(blob);
  if (!remote) return false;
  if (/\b(must|required|need)\s+(?:to\s+)?(?:be\s+)?(?:based|located|resident|living)\s+in\b/i.test(blob)) {
    return false;
  }
  if (/\bon[-\s]?site\s+(?:only|required|mandatory)\b/i.test(blob)) return false;
  return true;
}

export function assessLocationGeographyConflict(input: LocationGeographyVetoInput): {
  material_mismatch: boolean;
  user_primary: string | null;
  job_cities: string[];
  reason: string | null;
} {
  const preferredRaw = typeof input.preferredLocation === "string" ? input.preferredLocation.trim() : "";
  const firstSeg = firstCommaLocationSegment(preferredRaw || null);
  if (!firstSeg) {
    return { material_mismatch: false, user_primary: null, job_cities: [], reason: null };
  }
  const userPrimary = segmentToLocationSlug(firstSeg);
  if (!userPrimary || !isCityLikeSlug(userPrimary)) {
    return { material_mismatch: false, user_primary: userPrimary, job_cities: [], reason: null };
  }

  const combined = `${input.combinedJobText ?? ""}`;
  if (isRemoteWithoutResidenceConflict(input.workModel ?? null, combined)) {
    return { material_mismatch: false, user_primary: userPrimary, job_cities: [], reason: null };
  }

  const jobCities = collectJobCitySlugs(
    input.jobLocation,
    input.jobTextEnglish,
    combined,
  );
  const jobList = [...jobCities].sort();
  if (jobCities.size === 0) {
    return { material_mismatch: false, user_primary: userPrimary, job_cities: jobList, reason: null };
  }

  const userMetro = metroSlugsForUserPrimary(userPrimary);
  const aligned = [...jobCities].some((c) => userMetro.has(c));
  if (aligned) {
    return { material_mismatch: false, user_primary: userPrimary, job_cities: jobList, reason: null };
  }

  const userLabel = firstSeg;
  const reason = `Veto: dashboard target location "${userLabel}" conflicts with job geography "${jobList.join(", ")}" (on-site/hybrid base; server geography check).`;
  return {
    material_mismatch: true,
    user_primary: userPrimary,
    job_cities: jobList,
    reason,
  };
}

function slugToDisplayName(slug: string): string {
  if (!slug) return slug;
  return slug
    .split("-")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join("-");
}

/** User-facing one-liner for discovery / dashboard veto rows. */
export function formatLocationVetoHeadline(
  preferredLocation: string | null,
  jobCitySlugs: string[],
): string {
  const userPlace = firstCommaLocationSegment(preferredLocation) ?? "your target location";
  const jobPlaces =
    jobCitySlugs.length > 0
      ? jobCitySlugs.map(slugToDisplayName).join(", ")
      : "another city";
  return `Rejected: role is based in ${jobPlaces}, but your target location is ${userPlace}.`;
}

/**
 * Hard veto when tactics.location is default and cities materially clash.
 * With strong_preference, returns no veto (semantic scorer applies soft penalty; AI may still veto).
 */
export function inferLocationGeographyVeto(input: LocationGeographyVetoInput): OfflineVetoResult {
  if (stanceFor(input.tactics) === "strong_preference") {
    return { vetoed: false, veto_reason: null };
  }
  const assessment = assessLocationGeographyConflict(input);
  if (!assessment.material_mismatch || !assessment.reason) {
    return { vetoed: false, veto_reason: null };
  }
  return {
    vetoed: true,
    veto_reason: assessment.reason,
    user_message: formatLocationVetoHeadline(input.preferredLocation, assessment.job_cities),
  };
}

export function mergeOfflineVetos(...results: OfflineVetoResult[]): OfflineVetoResult {
  for (const r of results) {
    if (r.vetoed && r.veto_reason) return r;
  }
  return { vetoed: false, veto_reason: null };
}

type ReviewWithVetoFields = {
  vetoed: boolean;
  veto_reason: string | null;
  fit_score: number;
  metadata_fit_badge: "Location Conflict" | "Preference Match" | null;
  mathematical_breakdown: string;
  one_sentence_summary: string;
  narrative_summary?: string;
  fit_score_reconciled_from_components: boolean;
};

function geographyHeadlineAlreadyShown(review: ReviewWithVetoFields): boolean {
  const blob = `${review.veto_reason ?? ""} ${review.one_sentence_summary ?? ""}`.toLowerCase();
  return (
    /\brejected:\s*role is based in\b/.test(blob) ||
    /dashboard target location/.test(blob) ||
    /\btarget location is\b/.test(blob)
  );
}

/** Post-LLM safety net: apply geography hard veto if the model missed it (default tactic only). */
export function enforceLocationGeographyOnReview<T extends ReviewWithVetoFields>(
  review: T,
  input: LocationGeographyVetoInput,
): T {
  const assessment = assessLocationGeographyConflict(input);
  if (!assessment.material_mismatch || !assessment.reason) return review;
  if (stanceFor(input.tactics) === "strong_preference") return review;
  if (review.vetoed && geographyHeadlineAlreadyShown(review)) return review;

  const headline = formatLocationVetoHeadline(input.preferredLocation, assessment.job_cities);
  return {
    ...review,
    vetoed: true,
    veto_reason: assessment.reason,
    fit_score: 0,
    metadata_fit_badge: "Location Conflict",
    mathematical_breakdown: `VETO: ${assessment.reason}\nFinal Score: 0%.`,
    one_sentence_summary: headline,
    narrative_summary: "",
    fit_score_reconciled_from_components: false,
  };
}
