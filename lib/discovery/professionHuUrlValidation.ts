// lib/discovery/professionHuUrlValidation.ts — Profession.hu listing URL must reflect the intended search.

import { JOB_BOARD_BROAD_LOCATION_SLUGS } from "./locationPreferenceShared";
import { primaryCitySlugForJobBoardSearch } from "../pipeline/hungaryGeography";

function norm(s: string): string {
  return s.normalize("NFC").trim().toLowerCase();
}

/**
 * SERP URLs like /allasok/1,0,0,{slug}%40{n}%40{n}?keywordsearch encode the free-text query in the path
 * (slug is URI-encoded; trailing @digits@digits is Profession's own suffix).
 */
function phraseFromProfessionKeywordsearchPath(pathname: string): string | null {
  const path = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const m = path.match(/^\/allasok\/\d+,\d+,\d+,(.+)$/);
  if (!m) return null;
  const rawTail = m[1];
  try {
    const decoded = decodeURIComponent(rawTail.replace(/\+/g, " "));
    const stripped = decoded.replace(/@\d+@\d+$/u, "").trim();
    return stripped || null;
  } catch {
    return null;
  }
}

function parseProfessionUrl(pageUrl: string): URL | null {
  try {
    return new URL(pageUrl);
  } catch {
    return null;
  }
}

/** True when Profession listing URL is the generic homepage with no search query. */
export function isBareProfessionAllasokListing(pageUrl: string): boolean {
  const u = parseProfessionUrl(pageUrl);
  if (!u) return true;
  const host = u.hostname.replace(/^www\./, "");
  if (host !== "profession.hu") return false;
  const path = (u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname) || "/";
  const listingOnly =
    path === "/allasok" || path === "/allasok/1" || /^\/allasok\/\d+$/.test(path);
  if (!listingOnly) return false;
  const ap = u.searchParams.get("adv_pattern");
  const kw = u.searchParams.get("keyword");
  return (ap == null || ap.trim() === "") && (kw == null || kw.trim() === "");
}

/**
 * After navigation, the address bar must carry the search phrase as adv_pattern or keyword
 * (decoded match, NFC-normalised).
 */
export function professionListingUrlReflectsKeyword(pageUrl: string, expectedKeyword: string): boolean {
  const want = norm(expectedKeyword);
  if (!want) return true;
  const u = parseProfessionUrl(pageUrl);
  if (!u) return false;
  const ap = u.searchParams.get("adv_pattern");
  const kwp = u.searchParams.get("keyword");
  if (ap != null && norm(ap) === want) return true;
  if (kwp != null && norm(kwp) === want) return true;
  const pathPhrase = phraseFromProfessionKeywordsearchPath(u.pathname);
  if (pathPhrase != null && norm(pathPhrase) === want) return true;
  return false;
}

export function professionSearchNavigationFailureReason(pageUrl: string, expectedKeyword: string): string | null {
  if (professionListingUrlReflectsKeyword(pageUrl, expectedKeyword)) return null;
  if (isBareProfessionAllasokListing(pageUrl)) {
    return "redirected to base Profession.hu listing without adv_pattern/keyword";
  }
  return "URL missing matching adv_pattern or keyword for this search phrase";
}

/**
 * True for a job-posting href (`/allas/slug-1234567` or `/allas/1234567`), not a listing index.
 */
export function isProfessionJobListingHref(href: string): boolean {
  const path = href.split("?")[0] ?? href;
  if (/\/allasok\//i.test(path)) return false;
  return /\/allas\/[^?]*\d{4,}/i.test(path);
}

/** Absolute profession.hu detail URL without query/hash, or null if not a posting. */
export function normalizeProfessionDetailUrl(jobUrl: string): string | null {
  try {
    const u = new URL(jobUrl.trim());
    if (!u.hostname.replace(/^www\./, "").endsWith("profession.hu")) return null;
    if (!isProfessionJobListingHref(u.pathname)) return null;
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Maps dashboard target location (e.g. "Budapest, Hungary") to a Profession.hu path segment after `/allasok/`.
 * Returns null when unset, too broad, or not slug-safe.
 */
export function professionHuLocationSlugFromPreference(preferredLocation: string | null | undefined): string | null {
  const slug = primaryCitySlugForJobBoardSearch(preferredLocation);
  if (!slug || slug.length > 48) return null;
  if (JOB_BOARD_BROAD_LOCATION_SLUGS.has(slug)) return null;
  return slug;
}
