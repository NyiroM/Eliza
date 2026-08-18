// lib/discovery/sources/linkedinGuest.ts
import * as cheerio from "cheerio";
import type { DiscoveredJob, DiscoveryProviderId } from "../../../types/discovery";
import { readDiscoveryResponseText, timedDiscoveryFetch } from "../timedDiscoveryFetch";
import { stableJobId } from "../id";
import { extractLinkedInDescriptionFromHtml } from "./linkedinDetailParse";
import {
  extractLinkedInJobPostingId,
  linkedInGuestJobPostingUrl,
  linkedInPublicJobViewUrl,
} from "./linkedinJobUrl";
import { fetchJobDetailBodyPlaywright } from "./jobDetailPlaywright";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export async function fetchLinkedInGuestJobs(
  keywords: string,
  location = "Hungary",
  maxItems = 25,
): Promise<DiscoveredJob[]> {
  const kw = keywords.trim() || "developer";
  const base = new URL("https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search");
  base.searchParams.set("keywords", kw);
  base.searchParams.set("location", location);
  base.searchParams.set("f_TPR", "r604800");
  base.searchParams.set("start", "0");

  const res = await timedDiscoveryFetch(base.toString(), {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9,hu;q=0.8",
    },
  });
  if (!res.ok) {
    throw new Error(`LinkedIn guest search HTTP ${res.status}`);
  }
  const html = await readDiscoveryResponseText(res);
  const $ = cheerio.load(html);
  const provider: DiscoveryProviderId = "linkedin";
  const out: DiscoveredJob[] = [];

  $("div.base-card").each((_, card) => {
    if (out.length >= maxItems) return false;
    const $c = $(card);
    const title = $c.find("h3.base-search-card__title").text().trim();
    const company = $c.find("h4.base-search-card__subtitle").text().trim();
    const loc = $c.find("span.job-search-card__location").text().trim();
    const href = $c.find("a.base-card__full-link").attr("href")?.split("?")[0]?.trim();
    if (!href || !title) return;
    const descParts = [title, company && `Company: ${company}`, loc && `Location: ${loc}`].filter(Boolean);
    out.push({
      id: stableJobId(provider, href),
      provider,
      title,
      company: company || null,
      url: href,
      description: descParts.join("\n"),
      discovered_at: new Date().toISOString(),
    });
    return undefined;
  });

  return out;
}

export async function enrichLinkedInJobDescription(jobUrl: string): Promise<string | null> {
  const id = extractLinkedInJobPostingId(jobUrl);
  if (!id) {
    console.warn("[linkedinGuest] no numeric job id in url", jobUrl.slice(0, 140));
    return null;
  }
  const guestUrl = linkedInGuestJobPostingUrl(id);

  try {
    const res = await timedDiscoveryFetch(guestUrl, {
      headers: {
        "User-Agent": UA,
        Referer: "https://www.linkedin.com/jobs/search/",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (res.ok) {
      const html = await readDiscoveryResponseText(res);
      const text = extractLinkedInDescriptionFromHtml(html);
      if (text) return text;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[linkedinGuest] jobPosting HTTP enrich failed or timed out", id, msg);
  }

  if (process.env.ELIZA_DISCOVERY_PLAYWRIGHT === "0") return null;

  try {
    const fromGuest = await fetchJobDetailBodyPlaywright(guestUrl, "linkedin");
    if (fromGuest) return fromGuest;
    return await fetchJobDetailBodyPlaywright(linkedInPublicJobViewUrl(id), "linkedin");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[linkedinGuest] Playwright enrich failed", id, msg);
    return null;
  }
}
