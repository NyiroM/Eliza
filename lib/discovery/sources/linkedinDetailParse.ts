// lib/discovery/sources/linkedinDetailParse.ts — guest/view HTML → posting body.
import * as cheerio from "cheerio";
import { firstNonEmptyText, jobPostingDescriptionFromJsonLd } from "./htmlTextExtract";

const LINKEDIN_DESCRIPTION_SELECTORS = [
  ".show-more-less-html__markup",
  ".description__text",
  ".jobs-description-content__text",
  ".jobs-box__html-content",
  "#job-details",
] as const;

export function isLikelyLinkedInAuthWall(text: string): boolean {
  const t = text.toLowerCase();
  const auth = /\bsign in\b/.test(t) || /\bjoin now\b/.test(t) || /\bagree\s*&\s*join\b/.test(t);
  const jobby = /\b(responsibilities|requirements|qualifications|you will|job summary|key requirements)\b/.test(
    t,
  );
  return auth && !jobby;
}

export function extractLinkedInDescriptionFromHtml(html: string): string | null {
  const fromLd = jobPostingDescriptionFromJsonLd(html);
  if (fromLd && !isLikelyLinkedInAuthWall(fromLd)) return fromLd;

  const $ = cheerio.load(html);
  const fromDom = firstNonEmptyText($, [...LINKEDIN_DESCRIPTION_SELECTORS]);
  if (fromDom && !isLikelyLinkedInAuthWall(fromDom)) return fromDom;
  return null;
}
