// lib/discovery/sources/professionDetailParse.ts
import * as cheerio from "cheerio";
import { firstNonEmptyText, jobPostingDescriptionFromJsonLd } from "./htmlTextExtract";

const PROFESSION_DESCRIPTION_SELECTORS = [
  "article",
  '[class*="job-description"]',
  '[class*="JobDescription"]',
  '[data-testid*="description"]',
  "main",
] as const;

export function extractProfessionDescriptionFromHtml(html: string): string | null {
  const fromLd = jobPostingDescriptionFromJsonLd(html);
  if (fromLd) return fromLd;

  const $ = cheerio.load(html);
  return firstNonEmptyText($, [...PROFESSION_DESCRIPTION_SELECTORS]);
}
