// lib/discovery/sources/indeedPlaywright.ts — Hungary Indeed job search via Playwright (RSS replacement).
import { chromium, type Browser, type Page } from "playwright";
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { DiscoveredJob, DiscoveryProviderId } from "../../../types/discovery";
import { saveDiscoveryZeroResultScreenshot } from "../debugScreenshot";
import { stableJobId } from "../id";
import { indeedLocationParamFromPreference } from "../locationPreferenceShared";
import { indeedJkFromJobUrl, indeedSerpVjkUrl, resolveIndeedJobUrl } from "./indeedJobUrl";
import { extractIndeedDescriptionFromHtml, isIndeedChallengeHtml } from "./indeedDetailParse";
import {
  humanPause,
  initNavigatorWebdriverPatch,
  STEALTH_CHROMIUM_ARGS,
  wiggleMouse,
} from "../playwrightStealth";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function dismissIndeedCookies(page: Page): Promise<void> {
  const candidates = [
    "#onetrust-accept-btn-handler",
    'button:has-text("Accept All")',
    'button:has-text("Accept all")',
    'button:has-text("I Accept")',
    'button:has-text("Elfogad")',
    'button:has-text("Összes elfogadása")',
  ];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      await loc.click({ timeout: 2500 });
      await sleep(500);
      return;
    } catch {
      /* next */
    }
  }
}

function indeedSearchUrl(keywords: string, preferredLocation?: string | null): string {
  const q = keywords.trim() || "developer";
  const l = indeedLocationParamFromPreference(preferredLocation);
  return `https://hu.indeed.com/jobs?q=${encodeURIComponent(q)}&l=${encodeURIComponent(l)}`;
}

const JOB_CARD_LINK_SELECTORS = [
  "#mosaic-provider-jobcards a[data-jk]",
  ".job_seen_beacon a[data-jk]",
] as const;

/**
 * Hydrate a few JDs from the SERP split pane (same session that already passed Indeed).
 * Isolated `/viewjob` Playwright at eval often lands on Security Check.
 * Default cap 4; set `ELIZA_INDEED_DETAIL_VISITS=0` to skip.
 */
function indeedDetailVisitCap(listingCount: number): number {
  const raw = parseInt(process.env.ELIZA_INDEED_DETAIL_VISITS ?? "", 10);
  const cap = Number.isFinite(raw) ? raw : 4;
  return Math.max(0, Math.min(listingCount, cap));
}

function indeedCardTitle($: cheerio.CheerioAPI, a: Element): string {
  const $a = $(a);
  const titled = $a.find("span[title]").first().attr("title")?.trim();
  const label = $a.attr("aria-label")?.trim();
  return (titled || label || $a.text().trim() || "Job").slice(0, 300);
}

function indeedCardMeta(
  $: cheerio.CheerioAPI,
  a: Element,
): { company: string | null; location: string; snippet: string } {
  const card = $(a).closest(".job_seen_beacon, .cardOutline, [class*='jobCard']");
  const root = card.length ? card : $(a).parent();
  const company = root.find('[data-testid="company-name"]').first().text().trim() || null;
  const location = root.find('[data-testid="text-location"]').first().text().trim();
  const snippet = root.find(".job-snippet, [data-testid='job-snippet']").first().text().replace(/\s+/g, " ").trim();
  return { company, location, snippet };
}

async function hydrateIndeedJobsFromSerpPanel(page: Page, jobs: DiscoveredJob[], cap: number): Promise<void> {
  let consecutiveMisses = 0;
  for (let i = 0; i < Math.min(cap, jobs.length); i += 1) {
    const job = jobs[i];
    let jk = "";
    try {
      jk = new URL(job.url).searchParams.get("jk") ?? "";
    } catch {
      continue;
    }
    if (!jk) continue;
    try {
      await page.locator(`a[data-jk="${jk}"]`).first().click({ timeout: 4000 });
      await sleep(450);
      await page
        .waitForSelector("#jobDescriptionText, [data-testid='jobsearch-JobComponent-description']", {
          timeout: 8000,
        })
        .catch(() => {});
      const html = await page.content();
      if (isIndeedChallengeHtml(html)) {
        consecutiveMisses += 1;
        if (consecutiveMisses >= 2) break;
        continue;
      }
      const detailText = extractIndeedDescriptionFromHtml(html);
      if (detailText && detailText.length > 120) {
        job.description = detailText;
        consecutiveMisses = 0;
      } else {
        consecutiveMisses += 1;
        if (consecutiveMisses >= 3) break;
      }
    } catch {
      consecutiveMisses += 1;
      if (consecutiveMisses >= 3) break;
    }
  }
}

export async function openIndeedPlaywrightSession(): Promise<{ browser: Browser; page: Page }> {
  const launchOpts: Parameters<typeof chromium.launch>[0] = {
    headless: true,
    args: STEALTH_CHROMIUM_ARGS,
  };
  if (process.env.ELIZA_PLAYWRIGHT_CHROME_CHANNEL === "chrome") {
    launchOpts.channel = "chrome";
  }
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage({
    userAgent: UA,
    viewport: { width: 1365, height: 900 },
    locale: "hu-HU",
    timezoneId: "Europe/Budapest",
  });
  await initNavigatorWebdriverPatch(page);
  await wiggleMouse(page);
  return { browser, page };
}

export async function scrapeIndeedJobsOnPage(
  page: Page,
  keywords: string,
  maxItems = 25,
  preferredLocation?: string | null,
  opts?: { firstNav?: boolean },
): Promise<DiscoveredJob[]> {
  const listUrl = indeedSearchUrl(keywords, preferredLocation);
  const firstNav = opts?.firstNav !== false;
  if (firstNav) {
    await humanPause(400, 900);
  }
  await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await humanPause(firstNav ? 500 : 250, firstNav ? 1100 : 600);
  await wiggleMouse(page);
  await dismissIndeedCookies(page);
  await sleep(firstNav ? 500 : 250);
  await page
    .waitForSelector("a[data-jk], .job_seen_beacon, #mosaic-provider-jobcards", {
      timeout: firstNav ? 10_000 : 6_000,
    })
    .catch(() => {});

  const html = await page.content();
  if (isIndeedChallengeHtml(html)) return [];
  const $ = cheerio.load(html);
  const out: DiscoveredJob[] = [];
  const seenJk = new Set<string>();
  const provider: DiscoveryProviderId = "indeed";

  const tryPushAnchor = (a: Element): boolean | void => {
    if (out.length >= maxItems) return false;
    const url = resolveIndeedJobUrl($, a);
    if (!url) return;
    let jk: string;
    try {
      jk = new URL(url).searchParams.get("jk") ?? "";
    } catch {
      return;
    }
    if (!jk || seenJk.has(jk)) return;
    seenJk.add(jk);
    const title = indeedCardTitle($, a);
    const meta = indeedCardMeta($, a);
    const descParts = [
      title,
      meta.company ? `Company: ${meta.company}` : "",
      meta.location ? `Location: ${meta.location}` : "",
      meta.snippet,
      `Indeed: ${listUrl}`,
    ].filter(Boolean);
    out.push({
      id: stableJobId(provider, url),
      provider,
      title,
      company: meta.company,
      url,
      description: descParts.join("\n"),
      discovered_at: new Date().toISOString(),
    });
    if (out.length >= maxItems) return false;
    return undefined;
  };

  for (const sel of JOB_CARD_LINK_SELECTORS) {
    $(sel).each((_, a) => {
      const r = tryPushAnchor(a);
      if (r === false) return false;
      return undefined;
    });
    if (out.length >= maxItems) break;
  }

  if (out.length === 0) {
    $(".job_seen_beacon a[href*='viewjob'], .job_seen_beacon a[href*='jk=']").each((_, a) => {
      const r = tryPushAnchor(a);
      if (r === false) return false;
      return undefined;
    });
  }

  if (out.length === 0) {
    await saveDiscoveryZeroResultScreenshot("indeed", page, keywords);
  }

  const detailCap = indeedDetailVisitCap(out.length);
  if (detailCap > 0 && out.length > 0) {
    await hydrateIndeedJobsFromSerpPanel(page, out, detailCap);
  }

  return out;
}

/**
 * Fetches job cards from Indeed Hungary using Playwright with light stealth patterns.
 */
export async function fetchIndeedJobsPlaywright(
  keywords: string,
  maxItems = 25,
  preferredLocation?: string | null,
): Promise<DiscoveredJob[]> {
  const { browser, page } = await openIndeedPlaywrightSession();
  try {
    return await scrapeIndeedJobsOnPage(page, keywords, maxItems, preferredLocation, { firstNav: true });
  } finally {
    await browser.close();
  }
}

/**
 * Catalog / eval hydrate: one browser, `jobs?vjk=` (search session), not isolated `/viewjob`.
 * Mutates `jobs` in place when a JD is found.
 */
export async function hydrateIndeedJobsViaSerpVjk(jobs: DiscoveredJob[]): Promise<number> {
  const targets = jobs.filter((j) => j.provider === "indeed" && indeedJkFromJobUrl(j.url));
  if (targets.length === 0) return 0;

  const { browser, page } = await openIndeedPlaywrightSession();
  let hydrated = 0;
  let consecutiveMisses = 0;
  try {
    for (let i = 0; i < targets.length; i += 1) {
      const job = targets[i];
      const jk = indeedJkFromJobUrl(job.url);
      if (!jk) continue;
      try {
        await page.goto(indeedSerpVjkUrl(jk), { waitUntil: "domcontentloaded", timeout: 75_000 });
        if (i === 0) {
          await dismissIndeedCookies(page);
          await sleep(500);
        }
        await sleep(400);
        await page
          .waitForSelector("#jobDescriptionText, [data-testid='jobsearch-JobComponent-description']", {
            timeout: 10_000,
          })
          .catch(() => {});
        const html = await page.content();
        if (isIndeedChallengeHtml(html) || /security check/i.test(await page.title())) {
          consecutiveMisses += 1;
          if (consecutiveMisses >= 2) break;
          continue;
        }
        const detailText = extractIndeedDescriptionFromHtml(html);
        if (detailText && detailText.length > 120) {
          job.description = detailText;
          hydrated += 1;
          consecutiveMisses = 0;
        } else {
          consecutiveMisses += 1;
          if (consecutiveMisses >= 3) break;
        }
      } catch {
        consecutiveMisses += 1;
        if (consecutiveMisses >= 3) break;
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return hydrated;
}
