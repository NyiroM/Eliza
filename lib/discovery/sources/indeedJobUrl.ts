// lib/discovery/sources/indeedJobUrl.ts — Canonical Indeed HU posting URLs from listing anchors.
import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";

export const INDEED_HU_ORIGIN = "https://hu.indeed.com";

const SENTINEL_JKS = new Set(["123456789abcdef0"]);

function isValidIndeedJk(jk: string): boolean {
  const j = jk.trim();
  if (j.length < 10 || j.length > 24) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(j)) return false;
  if (SENTINEL_JKS.has(j.toLowerCase())) return false;
  return true;
}

/** Stable public job detail URL for storage and "Open posting". */
export function canonicalIndeedViewJobUrl(jk: string): string {
  return `${INDEED_HU_ORIGIN}/viewjob?jk=${encodeURIComponent(jk.trim())}`;
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
