// lib/discovery/id.ts
import { createHash } from "node:crypto";

const TRACKING_PARAM_PREFIXES: readonly string[] = ["utm_", "mc_", "_ga", "_hs"];

const TRACKING_PARAM_EXACT: ReadonlySet<string> = new Set([
  "gclid",
  "fbclid",
  "msclkid",
  "yclid",
  "dclid",
  "ref",
  "referer",
  "referrer",
  "source",
  "src",
  "campaign",
  "trk",
  "trkcampaign",
  "trkinfo",
  "origin",
  "share",
  "shared",
]);

const PER_PROVIDER_DROP_PARAMS: Record<string, ReadonlySet<string>> = {
  linkedin: new Set([
    "pageNum",
    "position",
    "refId",
    "originalSubdomain",
    "lipi",
    "lici",
    "midToken",
    "trackingId",
    "eBP",
  ]),
  indeed: new Set(["from", "tk", "advn", "vjs", "alid", "rgtk", "fromage", "sjdu", "hl"]),
  profession: new Set(["keywordsearch", "page", "adv_pattern", "keyword", "sort", "from"]),
};

function shouldDropParam(provider: string, name: string): boolean {
  const lc = name.toLowerCase();
  for (const prefix of TRACKING_PARAM_PREFIXES) {
    if (lc.startsWith(prefix)) return true;
  }
  if (TRACKING_PARAM_EXACT.has(lc)) return true;
  const perProvider = PER_PROVIDER_DROP_PARAMS[provider];
  if (perProvider && perProvider.has(name)) return true;
  return false;
}

function canonicalizeProfessionDetailPath(pathname: string): string {
  // Profession detail URLs are /allas/<numeric-id>-<slug>; collapse to /allas/<numeric-id>.
  const m = pathname.match(/^\/allas\/(\d+)(?:[-/].*)?$/i);
  return m ? `/allas/${m[1]}` : pathname;
}

function canonicalizeIndeedPath(pathname: string): string {
  // Indeed detail variants: /viewjob, /rc/clk, /m/jobs/view; only `jk` query param matters,
  // which is preserved by the param filter below. Strip trailing slashes for consistency.
  return pathname.replace(/\/+$/, "") || "/";
}

/**
 * Normalise a job URL so cosmetic drift (tracking params, casing, trailing slash, fragments)
 * collapses to a single identity per posting. Provider-specific path rewrites apply where the
 * provider exposes the same posting under multiple slugs.
 */
export function canonicalizeJobUrl(provider: string, raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    // Fall back: lowercase + strip trailing slash for path-only refs like "/allas/123-foo".
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }

  u.hash = "";
  u.username = "";
  u.password = "";
  u.host = u.host.toLowerCase().replace(/^www\./, "");
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
    u.port = "";
  }

  const dropped: string[] = [];
  for (const [name] of [...u.searchParams.entries()]) {
    if (shouldDropParam(provider, name)) dropped.push(name);
  }
  for (const name of dropped) u.searchParams.delete(name);

  // Sort remaining params for stability across page-builder ordering.
  const remaining = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  for (const [k, v] of remaining) u.searchParams.append(k, v);

  let pathname = u.pathname.replace(/\/+$/, "");
  if (provider === "profession") pathname = canonicalizeProfessionDetailPath(pathname);
  else if (provider === "indeed") pathname = canonicalizeIndeedPath(pathname);
  u.pathname = pathname || "/";

  return u.toString();
}

export function stableJobId(provider: string, url: string): string {
  return createHash("sha256")
    .update(`${provider}|${canonicalizeJobUrl(provider, url)}`)
    .digest("hex")
    .slice(0, 24);
}
