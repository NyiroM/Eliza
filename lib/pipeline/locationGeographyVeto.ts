// lib/pipeline/locationGeographyVeto.ts — deterministic dashboard geography vs job location (AI may also veto).

import type { StoredConstraintTactics } from "../storage/constraintTactics";
import {
  expandPreferredLocationToCitySlugs,
  formatPreferredLocationLabel,
  FOREIGN_LOCATION_CITY_SLUGS,
  hasActionablePreferredGeography,
  KNOWN_LOCATION_CITY_SLUGS,
} from "./hungaryGeography";
import { JOB_BOARD_BROAD_LOCATION_SLUGS, GEOGRAPHY_COUNTRY_SLUGS, segmentToLocationSlug } from "../discovery/locationPreferenceShared";
import { classifyVetoReasonTactic } from "./constraintVetoTactics";

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

function isCityLikeSlug(slug: string): boolean {
  return slug.length >= 3 && !GEOGRAPHY_COUNTRY_SLUGS.has(slug) && !JOB_BOARD_BROAD_LOCATION_SLUGS.has(slug);
}

function isIncidentalGeographyMention(norm: string, matchIndex: number): boolean {
  const window = norm.slice(Math.max(0, matchIndex - 100), Math.min(norm.length, matchIndex + 48));
  return (
    /\b(headquarters|headquartered|head\s*office|\bhq\b|registered\s+office|parent\s+company|szekhely|kozpont)\b/.test(
      window,
    ) ||
    /\b(our\s+)?offices?\s+(are\s+)?in\b/.test(window) ||
    /\b(cooperation|collaborate|collaboration|working with|work with)\b.{0,60}\b(headquarters|\bhq\b|head office)\b/.test(
      window,
    )
  );
}

function citySlugPattern(city: string): string {
  return city.replace(/-/g, "[-\\s]?");
}

function slugHasNonIncidentalMention(norm: string, city: string): boolean {
  const re = new RegExp(`\\b${citySlugPattern(city)}\\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    if (!isIncidentalGeographyMention(norm, m.index)) return true;
  }
  return false;
}

function hasExplicitRoleBaseInCity(norm: string, city: string): boolean {
  const c = citySlugPattern(city);
  return new RegExp(
    `\\b(?:based|located|office|on-?site|hybrid|role)\\s+(?:in|at)\\s+${c}\\b|\\b${c}\\s+(?:office|site|based|on-?site)\\b`,
    "i",
  ).test(norm);
}

function hasHungaryCountrySignal(norm: string): boolean {
  return /\bhungary\b/.test(norm) || /\bmagyarorszag\b/.test(norm);
}

function collectKnownCitySlugsFromText(text: string): Set<string> {
  const out = new Set<string>();
  const norm = text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  for (const city of KNOWN_LOCATION_CITY_SLUGS) {
    if (!slugHasNonIncidentalMention(norm, city)) continue;
    out.add(city);
  }
  return out;
}

function shouldAddJobLocationFieldSlug(slug: string, blob: string): boolean {
  if (GEOGRAPHY_COUNTRY_SLUGS.has(slug)) return false;
  const norm = blob
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  if (!FOREIGN_LOCATION_CITY_SLUGS.has(slug)) return true;
  if (hasExplicitRoleBaseInCity(norm, slug)) return true;
  if (hasHungaryCountrySignal(norm)) return false;
  return slugHasNonIncidentalMention(norm, slug);
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
      if (KNOWN_LOCATION_CITY_SLUGS.has(part)) out.add(part);
    }
    const tail = parts[parts.length - 1];
    if (tail && /^\d+$/.test(tail) && parts.length >= 2) {
      const beforeId = parts[parts.length - 2];
      if (KNOWN_LOCATION_CITY_SLUGS.has(beforeId)) out.add(beforeId);
    }
  } catch {
    /* ignore */
  }
  return out;
}

function primarySlugFromJobLocationField(jobLocation: string | null): string | null {
  if (!jobLocation?.trim()) return null;
  const parts = jobLocation.split(/[,;|/–—]/).map((s) => s.trim()).filter(Boolean);
  const slugs = parts.map(segmentToLocationSlug).filter(Boolean);
  const huCity = slugs.find(
    (s) => KNOWN_LOCATION_CITY_SLUGS.has(s) && !FOREIGN_LOCATION_CITY_SLUGS.has(s) && isCityLikeSlug(s),
  );
  if (huCity) return huCity;
  const first = slugs[0] ?? "";
  if (!first || !isCityLikeSlug(first) || GEOGRAPHY_COUNTRY_SLUGS.has(first)) return null;
  return first;
}

function collectJobCitySlugs(
  jobLocation: string | null,
  jobTextEnglish: string,
  combinedJobText: string,
): Set<string> {
  const postingBlob = `${jobTextEnglish}\n${combinedJobText}`;
  const out = collectKnownCitySlugsFromText(postingBlob);
  const fromField = primarySlugFromJobLocationField(jobLocation);
  if (fromField && shouldAddJobLocationFieldSlug(fromField, `${jobLocation ?? ""}\n${postingBlob}`)) {
    out.add(fromField);
  }
  const url = extractJobUrlFromBlob(`${jobLocation ?? ""}\n${postingBlob}`);
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
    /\bwork\s+from\s+home\b/i.test(blob) ||
    /\bthis role is remote\b/i.test(blob) ||
    /\brole is remote\b/i.test(blob) ||
    /\bremote\s+or\s+hybrid\b/i.test(blob) ||
    /\bhybrid\s+or\s+remote\b/i.test(blob);
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
  if (!preferredRaw || !hasActionablePreferredGeography(preferredRaw)) {
    return { material_mismatch: false, user_primary: null, job_cities: [], reason: null };
  }

  const allowedCities = expandPreferredLocationToCitySlugs(preferredRaw);
  const userLabel = formatPreferredLocationLabel(preferredRaw);

  const combined = `${input.combinedJobText ?? ""}`;
  const scanBlob = `${input.workModel ?? ""}\n${input.jobLocation ?? ""}\n${input.jobTextEnglish}\n${combined}`;
  if (isRemoteWithoutResidenceConflict(input.workModel ?? null, scanBlob)) {
    return { material_mismatch: false, user_primary: userLabel, job_cities: [], reason: null };
  }

  const jobCities = collectJobCitySlugs(
    input.jobLocation,
    input.jobTextEnglish,
    combined,
  );
  const jobList = [...jobCities].sort();
  if (jobCities.size === 0) {
    return { material_mismatch: false, user_primary: userLabel, job_cities: jobList, reason: null };
  }

  const aligned = [...jobCities].some((c) => allowedCities.has(c));
  if (aligned) {
    return { material_mismatch: false, user_primary: userLabel, job_cities: jobList, reason: null };
  }

  const reason = `Veto: dashboard target location "${userLabel}" conflicts with job geography "${jobList.join(", ")}" (on-site/hybrid base; server geography check).`;
  return {
    material_mismatch: true,
    user_primary: userLabel,
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
  const userPlace = formatPreferredLocationLabel(preferredLocation);
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
  matched_skills: string[];
  missing_skills: string[];
  seniority_match: boolean;
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

function isLocationOnlyModelVeto(review: ReviewWithVetoFields): boolean {
  if (!review.vetoed) return false;
  if (review.metadata_fit_badge === "Location Conflict") return true;
  if (geographyHeadlineAlreadyShown(review)) return true;
  return classifyVetoReasonTactic(review.veto_reason) === "location";
}

export type GeographyScoreRestore = {
  fit_score: number;
  matched_skills: string[];
  missing_skills: string[];
  seniority_match: boolean;
};

/** Post-LLM safety net: apply geography hard veto if the model missed it (default tactic only).
 * If the model vetoed on location but the server set is aligned, lift that veto. */
export function enforceLocationGeographyOnReview<T extends ReviewWithVetoFields>(
  review: T,
  input: LocationGeographyVetoInput,
  restoreFrom?: GeographyScoreRestore,
): T {
  const assessment = assessLocationGeographyConflict(input);
  if (!assessment.material_mismatch) {
    if (!isLocationOnlyModelVeto(review)) return review;
    const matchedLower = [...new Set((restoreFrom?.matched_skills ?? review.matched_skills).map((s) => s.toLowerCase()))].sort();
    const missingLower = [...new Set((restoreFrom?.missing_skills ?? review.missing_skills).map((s) => s.toLowerCase()))].sort();
    const note = "[Geography: listing matches dashboard target cities/counties; location-only veto lifted.]\n\n";
    return {
      ...review,
      vetoed: false,
      veto_reason: null,
      fit_score: restoreFrom?.fit_score ?? review.fit_score,
      matched_skills: matchedLower,
      missing_skills: missingLower,
      seniority_match: restoreFrom?.seniority_match ?? review.seniority_match,
      metadata_fit_badge: "Preference Match",
      mathematical_breakdown:
        note +
        (review.mathematical_breakdown?.trim().length
          ? review.mathematical_breakdown
          : `Literal baseline reference: ${restoreFrom?.fit_score ?? review.fit_score}%.`),
      one_sentence_summary: review.one_sentence_summary?.replace(/^veto(ed)?:\s*/i, "") || review.one_sentence_summary,
      fit_score_reconciled_from_components: false,
    };
  }
  if (!assessment.reason) return review;
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
