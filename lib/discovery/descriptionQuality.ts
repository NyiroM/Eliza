// lib/discovery/descriptionQuality.ts — detect listing-only blurbs that need detail-page fetch.
import type { DiscoveredJob, DiscoveryProviderId } from "../../types/discovery";

/** Below this length, always try detail-page enrichment before pipeline eval. */
export const DISCOVERY_DESCRIPTION_ENRICH_MIN_CHARS = 400;

const LISTING_ONLY_MARKERS: RegExp[] = [
  /\nIndeed:\s*https?:\/\//i,
  /^Indeed:\s*https?:\/\//im,
  /\nSource listing:\s*https?:\/\//i,
  /^Source listing:\s*https?:\/\//im,
  /\nListing:\s*https?:\/\//i,
  /^Listing:\s*https?:\/\//im,
];

export function isListingOnlyDiscoveryBlurb(body: string): boolean {
  const t = body.trim();
  if (!t) return true;
  return LISTING_ONLY_MARKERS.some((re) => re.test(t));
}

export function isThinDiscoveryDescription(
  body: string,
  _provider?: DiscoveryProviderId,
): boolean {
  const t = body.trim();
  if (!t) return true;
  if (t.length < DISCOVERY_DESCRIPTION_ENRICH_MIN_CHARS) return true;
  if (t.length < 900 && isListingOnlyDiscoveryBlurb(t)) return true;
  return false;
}

export function jobNeedsDescriptionEnrichment(job: Pick<DiscoveredJob, "description" | "provider">): boolean {
  return isThinDiscoveryDescription(job.description ?? "", job.provider);
}
