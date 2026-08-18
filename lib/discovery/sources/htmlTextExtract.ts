// lib/discovery/sources/htmlTextExtract.ts — shared HTML → plain text for job detail pages.
import * as cheerio from "cheerio";

export function stripHtmlToPlainText(htmlFragment: string): string {
  const $ = cheerio.load(htmlFragment, null, false);
  return $.root().text().replace(/\s+/g, " ").trim();
}

const MIN_DETAIL_TEXT_CHARS = 24;

export function firstNonEmptyText($: cheerio.CheerioAPI, selectors: string[]): string | null {
  for (const sel of selectors) {
    const t = $(sel).first().text().replace(/\s+/g, " ").trim();
    if (t.length > MIN_DETAIL_TEXT_CHARS) return t.slice(0, 14_000);
  }
  return null;
}

export function jobPostingDescriptionFromJsonLd(html: string): string | null {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const el of scripts) {
    const raw = $(el).html()?.trim();
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        if (!node || typeof node !== "object") continue;
        const o = node as Record<string, unknown>;
        const type = o["@type"];
        const types = Array.isArray(type) ? type : type ? [type] : [];
        if (!types.some((t) => String(t).toLowerCase().includes("jobposting"))) continue;
        const desc = o.description;
        if (typeof desc === "string" && desc.trim().length > 0) {
          const plain = stripHtmlToPlainText(desc);
          if (plain.length > 40) return plain.slice(0, 14_000);
        }
      }
    } catch {
      /* next script block */
    }
  }
  return null;
}
