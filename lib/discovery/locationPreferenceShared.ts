// lib/discovery/locationPreferenceShared.ts — shared parsing of dashboard target location for job-board URLs.

import { PREFERRED_LOCATION_MAX_CHARS } from "../../config/constants";

/** Country / remote-style labels: do not narrow to a city path or city-shaped Indeed `l=`. */
export const JOB_BOARD_BROAD_LOCATION_SLUGS = new Set([
  "hungary",
  "magyarorszag",
  "orszag",
  "country",
  "worldwide",
  "remote",
  "eu",
  "europe",
]);

/** Country names that must not be treated as a job's on-site city (office lists, HQ countries). */
export const GEOGRAPHY_COUNTRY_SLUGS = new Set([
  ...JOB_BOARD_BROAD_LOCATION_SLUGS,
  "latvia",
  "latvija",
  "serbia",
  "srbija",
  "croatia",
  "slovenia",
  "slovakia",
  "czechia",
  "czech-republic",
  "austria",
  "germany",
  "poland",
  "romania",
  "bulgaria",
  "greece",
  "italy",
  "spain",
  "portugal",
  "france",
  "netherlands",
  "belgium",
  "switzerland",
  "sweden",
  "norway",
  "finland",
  "denmark",
  "estonia",
  "lithuania",
  "ukraine",
  "moldova",
  "ireland",
  "united-kingdom",
  "uk",
  "usa",
  "united-states",
]);

export function parsePreferredLocationSegments(preferredLocation: string | null | undefined): string[] {
  if (preferredLocation == null) return [];
  return preferredLocation
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function firstCommaLocationSegment(preferredLocation: string | null | undefined): string | null {
  const first = parsePreferredLocationSegments(preferredLocation)[0];
  return first ?? null;
}

export function segmentToLocationSlug(segment: string): string {
  const deacc = segment.normalize("NFD").replace(/\p{M}+/gu, "");
  return deacc
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Indeed `l=` (and similar) — default national; first comma segment when it looks like a city/region.
 */
export function indeedLocationParamFromPreference(preferredLocation: string | null | undefined): string {
  const first = firstCommaLocationSegment(preferredLocation);
  if (!first) return "Hungary";
  const slug = segmentToLocationSlug(first);
  if (!slug || JOB_BOARD_BROAD_LOCATION_SLUGS.has(slug)) return "Hungary";
  return first.slice(0, PREFERRED_LOCATION_MAX_CHARS);
}
