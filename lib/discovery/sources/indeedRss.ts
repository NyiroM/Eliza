// lib/discovery/sources/indeedRss.ts
import * as cheerio from "cheerio";
import type { DiscoveredJob, DiscoveryProviderId } from "../../../types/discovery";
import { stableJobId } from "../id";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const RSS_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept: "application/rss+xml, application/xml, text/xml, application/atom+xml;q=0.9, */*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,hu;q=0.8",
  Referer: "https://www.indeed.com/",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

function buildIndeedRssUrlCandidates(keywords: string): string[] {
  const q = keywords.trim() || "developer";
  const enc = encodeURIComponent(q);
  return [
    `https://rss.indeed.com/rss?q=${enc}&l=Hungary`,
    `https://www.indeed.com/rss?q=${enc}&l=Hungary`,
    `https://rss.indeed.com/rss?q=${enc}`,
    `https://www.indeed.com/rss?q=${enc}`,
  ];
}

export async function fetchIndeedRssJobs(keywords: string, maxItems = 25): Promise<DiscoveredJob[]> {
  const q = keywords.trim() || "developer";
  const urls = buildIndeedRssUrlCandidates(q);
  let lastStatus = 0;
  let xml = "";
  for (const url of urls) {
    const res = await fetch(url, { headers: RSS_HEADERS });
    lastStatus = res.status;
    if (res.ok) {
      xml = await res.text();
      break;
    }
  }
  if (!xml) {
    throw new Error(`Indeed RSS HTTP ${lastStatus} (tried ${urls.length} feed URL(s))`);
  }
  const $ = cheerio.load(xml, { xml: true });
  const out: DiscoveredJob[] = [];
  const provider: DiscoveryProviderId = "indeed";
  $("item").each((_, el) => {
    if (out.length >= maxItems) return false;
    const title = $(el).find("title").first().text().trim();
    const link = $(el).find("link").first().text().trim();
    const desc = $(el).find("description").first().text().trim();
    if (!link || !title) return;
    const jobUrl = link.split("?")[0];
    out.push({
      id: stableJobId(provider, jobUrl),
      provider,
      title,
      company: null,
      url: jobUrl,
      description: desc || title,
      discovered_at: new Date().toISOString(),
    });
    return undefined;
  });
  return out;
}
