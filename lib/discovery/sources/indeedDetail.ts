// lib/discovery/sources/indeedDetail.ts — Indeed HU viewjob detail text (HTTP + optional Playwright).
import { readDiscoveryResponseText, timedDiscoveryFetch } from "../timedDiscoveryFetch";
import { INDEED_HU_ORIGIN, indeedJkFromJobUrl, indeedSerpVjkUrl } from "./indeedJobUrl";
import { extractIndeedDescriptionFromHtml } from "./indeedDetailParse";
import { fetchJobDetailBodyPlaywright } from "./jobDetailPlaywright";

export { extractIndeedDescriptionFromHtml } from "./indeedDetailParse";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function normalizeIndeedDetailUrl(jobUrl: string): string | null {
  const jk = indeedJkFromJobUrl(jobUrl);
  if (!jk) return null;
  return `${INDEED_HU_ORIGIN}/viewjob?jk=${encodeURIComponent(jk)}`;
}

async function httpIndeedText(url: string): Promise<string | null> {
  const res = await timedDiscoveryFetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7",
      Referer: `${INDEED_HU_ORIGIN}/jobs`,
    },
  });
  if (!res.ok) return null;
  const html = await readDiscoveryResponseText(res);
  return extractIndeedDescriptionFromHtml(html);
}

export async function enrichIndeedJobDescription(jobUrl: string): Promise<string | null> {
  const detailUrl = normalizeIndeedDetailUrl(jobUrl);
  if (!detailUrl) return null;
  const jk = indeedJkFromJobUrl(detailUrl);
  if (!jk) return null;

  try {
    const fromView = await httpIndeedText(detailUrl);
    if (fromView) return fromView;
    const fromSerp = await httpIndeedText(indeedSerpVjkUrl(jk));
    if (fromSerp) return fromSerp;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[indeedDetail] HTTP enrich failed", detailUrl.slice(0, 80), msg);
  }

  try {
    const fromSerpPw = await fetchJobDetailBodyPlaywright(indeedSerpVjkUrl(jk), "indeed");
    if (fromSerpPw) return fromSerpPw;
    return await fetchJobDetailBodyPlaywright(detailUrl, "indeed");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[indeedDetail] Playwright enrich failed", detailUrl.slice(0, 80), msg);
    return null;
  }
}
