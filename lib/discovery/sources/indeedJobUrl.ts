// lib/discovery/sources/indeedJobUrl.ts — Canonical Indeed HU posting URLs from listing anchors.
import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";

export const INDEED_HU_ORIGIN = "https://hu.indeed.com";

// Indeed renders skeleton/template anchors whose `jk` is a rotation of "0123456789abcdef"
// (e.g. "123456789abcdef0", "789abcdef0123456"). Real jks are random 16-char hex; the chance
// a genuine one is a permutation containing every hex digit exactly once is ~16!/16^16 ≈ 2.7e-7,
// so that signature is treated as a sentinel.
const SENTINEL_JKS = new Set(["123456789abcdef0", "789abcdef0123456"]);

function isHexDigitPermutationSentinel(jk: string): boolean {
  if (jk.length !== 16) return false;
  if (!/^[0-9a-f]{16}$/.test(jk)) return false;
  return new Set(jk).size === 16;
}

function isValidIndeedJk(jk: string): boolean {
  const j = jk.trim();
  if (j.length < 10 || j.length > 24) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(j)) return false;
  const lower = j.toLowerCase();
  if (SENTINEL_JKS.has(lower)) return false;
  if (isHexDigitPermutationSentinel(lower)) return false;
  return true;
}

/** Stable public job detail URL for storage and "Open posting". */
export function canonicalIndeedViewJobUrl(jk: string): string {
  return `${INDEED_HU_ORIGIN}/viewjob?jk=${encodeURIComponent(jk.trim())}`;
}

export function indeedJkFromJobUrl(jobUrl: string): string | null {
  try {
    const u = new URL(jobUrl.trim(), INDEED_HU_ORIGIN);
    const jk = u.searchParams.get("jk")?.trim() || u.searchParams.get("vjk")?.trim();
    return jk || null;
  } catch {
    return null;
  }
}

export function indeedSerpVjkUrl(jk: string): string {
  return `${INDEED_HU_ORIGIN}/jobs?vjk=${encodeURIComponent(jk.trim())}`;
}

/** Search URL copied into listing-only blurbs (`Indeed: https://hu.indeed.com/jobs?q=…`). */
export function indeedSearchUrlFromListingBlurb(description: string): string | null {
  const m = description.match(/^Indeed:\s*(https?:\/\/\S+)/im);
  if (!m?.[1]) return null;
  try {
    const u = new URL(m[1].trim());
    if (!/(^|\.)indeed\.com$/i.test(u.hostname)) return null;
    if (!u.pathname.startsWith("/jobs")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** `jobs?q=…&l=…&vjk=` — same search session as the listing scrape, not a cold `/jobs?vjk=` hit. */
export function indeedSerpVjkOnSearchUrl(searchUrl: string | null | undefined, jk: string): string {
  const vjk = jk.trim();
  if (!searchUrl) return indeedSerpVjkUrl(vjk);
  try {
    const u = new URL(searchUrl);
    u.searchParams.set("vjk", vjk);
    return u.toString();
  } catch {
    return indeedSerpVjkUrl(vjk);
  }
}

/**
 * Prefer `jk` from resolved href; fall back to data-jk. Returns null if unusable.
 */
export function resolveIndeedJobUrl($: CheerioAPI, el: Element): string | null {
  const $a = $(el);
  const hrefRaw = ($a.attr("href") ?? "").trim();
  const href = hrefRaw || "/";
  const dataJk = ($a.attr("data-jk") ?? "").trim();

  let parsed: URL;
  try {
    parsed = new URL(href, INDEED_HU_ORIGIN);
  } catch {
    return null;
  }

  let jk = parsed.searchParams.get("jk")?.trim() ?? "";
  if (!jk) jk = dataJk;
  if (!jk || !isValidIndeedJk(jk)) return null;

  return canonicalIndeedViewJobUrl(jk);
}
