// lib/discovery/sources/professionHu.ts
import * as cheerio from "cheerio";
import type { DiscoveredJob, DiscoveryProviderId } from "../../../types/discovery";
import { stableJobId } from "../id";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Best-effort HTML scrape of profession.hu listing (no Playwright).
 * If the page is mostly client-rendered, this may return few rows; users can rely on Indeed/LinkedIn or extend with Playwright later.
 */
export async function fetchProfessionHuJobs(keywords: string, maxItems = 20): Promise<DiscoveredJob[]> {
  const raw = (keywords.trim() || "fejlesztő").trim();
  const listUrl = `https://www.profession.hu/allasok?adv_pattern=${encodeURIComponent(raw)}`;
  const res = await fetch(listUrl, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "hu,en;q=0.9",
    },
  });
  if (!res.ok) {
    throw new Error(`Profession.hu list HTTP ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);
  const provider: DiscoveryProviderId = "profession";
  const out: DiscoveredJob[] = [];
  const seen = new Set<string>();

  $("a[href*='/allas/']").each((_, a) => {
    if (out.length >= maxItems) return false;
    const href = $(a).attr("href")?.trim();
    if (!href || href.includes("/allasok") || !/\/allas\/\d+/i.test(href)) return;
    const abs = href.startsWith("http") ? href : `https://www.profession.hu${href.startsWith("/") ? "" : "/"}${href}`;
    const pathOnly = abs.split("?")[0];
    if (seen.has(pathOnly)) return;
    seen.add(pathOnly);
    const title = $(a).text().trim() || $(a).attr("title")?.trim() || "Job";
    if (title.length < 2) return;
    out.push({
      id: stableJobId(provider, pathOnly),
      provider,
      title: title.slice(0, 300),
      company: null,
      url: pathOnly,
      description: `${title}\nSource listing: ${listUrl}`,
      discovered_at: new Date().toISOString(),
    });
    return undefined;
  });

  return out;
}
