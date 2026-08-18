// lib/discovery/sources/indeedDetailParse.ts
import * as cheerio from "cheerio";
import { firstNonEmptyText, jobPostingDescriptionFromJsonLd, stripHtmlToPlainText } from "./htmlTextExtract";

const INDEED_DESCRIPTION_SELECTORS = [
  "#jobDescriptionText",
  '[data-testid="jobsearch-JobComponent-description"]',
  ".jobsearch-JobComponent-description",
  '[data-testid="jobDescriptionText"]',
  ".jobsearch-jobDescriptionText",
  "#job-details",
  '[id*="jobDescription"]',
] as const;

export function isIndeedChallengeHtml(html: string): boolean {
  const head = html.slice(0, 12_000);
  return /Security Check\s*[-–]\s*Indeed/i.test(head) || /<title>[^<]*Security Check/i.test(head);
}

function indeedDescriptionFromEmbeddedJson(html: string): string | null {
  const patterns = [
    /"jobDescription"\s*:\s*"((?:\\.|[^"\\]){40,})"/,
    /"jobDescriptionText"\s*:\s*"((?:\\.|[^"\\]){40,})"/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m?.[1]) continue;
    try {
      const raw = JSON.parse(`"${m[1]}"`);
      const plain = stripHtmlToPlainText(String(raw));
      if (plain.length > 40) return plain.slice(0, 14_000);
    } catch {
      /* next pattern */
    }
  }
  return null;
}

export function extractIndeedDescriptionFromHtml(html: string): string | null {
  if (isIndeedChallengeHtml(html)) return null;

  const fromLd = jobPostingDescriptionFromJsonLd(html);
  if (fromLd) return fromLd;

  const $ = cheerio.load(html);
  const fromSel = firstNonEmptyText($, [...INDEED_DESCRIPTION_SELECTORS]);
  if (fromSel) return fromSel;

  return indeedDescriptionFromEmbeddedJson(html);
}
