// lib/discovery/sources/professionDetail.ts — profession.hu job detail text (HTTP + optional Playwright).
import { readDiscoveryResponseText, timedDiscoveryFetch } from "../timedDiscoveryFetch";
import { extractProfessionDescriptionFromHtml } from "./professionDetailParse";
import { fetchJobDetailBodyPlaywright } from "./jobDetailPlaywright";

export { extractProfessionDescriptionFromHtml } from "./professionDetailParse";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function normalizeProfessionDetailUrl(jobUrl: string): string | null {
  try {
    const u = new URL(jobUrl.trim());
    if (!u.hostname.includes("profession.hu")) return null;
    if (!/\/allas\/\d+/i.test(u.pathname)) return null;
    u.hash = "";
    return u.toString().split("?")[0] ?? null;
  } catch {
    return null;
  }
}

export async function enrichProfessionJobDescription(jobUrl: string): Promise<string | null> {
  const detailUrl = normalizeProfessionDetailUrl(jobUrl);
  if (!detailUrl) return null;

  try {
    const res = await timedDiscoveryFetch(detailUrl, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "hu,en;q=0.9",
        Referer: "https://www.profession.hu/allasok",
      },
    });
    if (res.ok) {
      const html = await readDiscoveryResponseText(res);
      const text = extractProfessionDescriptionFromHtml(html);
      if (text) return text;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[professionDetail] HTTP enrich failed", detailUrl.slice(0, 80), msg);
  }

  try {
    return await fetchJobDetailBodyPlaywright(detailUrl, "profession");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[professionDetail] Playwright enrich failed", detailUrl.slice(0, 80), msg);
    return null;
  }
}
