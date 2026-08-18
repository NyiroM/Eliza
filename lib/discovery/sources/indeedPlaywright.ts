// lib/discovery/sources/indeedPlaywright.ts — Hungary Indeed job search via Playwright (RSS replacement).
import { chromium, type Browser, type Page } from "playwright";
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { DiscoveredJob, DiscoveryProviderId } from "../../../types/discovery";
import { saveDiscoveryZeroResultScreenshot } from "../debugScreenshot";
import { stableJobId } from "../id";
import { indeedLocationParamFromPreference } from "../locationPreferenceShared";
import { isThinDiscoveryDescription } from "../descriptionQuality";
import {
  INDEED_HU_ORIGIN,
  indeedJkFromJobUrl,
  indeedSearchUrlFromListingBlurb,
  indeedSerpVjkOnSearchUrl,
  resolveIndeedJobUrl,
} from "./indeedJobUrl";
import { extractIndeedDescriptionFromHtml, isIndeedChallengeHtml } from "./indeedDetailParse";
import { progressCatalogHydrate } from "../progress";
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
 * Hydrate JDs from the SERP split pane in the same session that already passed Indeed.
 * Isolated Playwright after the listing browser closes hits Security Check.
 * Default: every card on the page. `ELIZA_INDEED_DETAIL_VISITS=0` skips; a number caps clicks.
 */
function indeedDetailVisitCap(listingCount: number): number {
  const raw = parseInt(process.env.ELIZA_INDEED_DETAIL_VISITS ?? "", 10);
  if (Number.isFinite(raw)) return Math.max(0, Math.min(listingCount, raw));
  return listingCount;
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

async function indeedPageLooksChallenged(page: Page): Promise<boolean> {
  const html = await page.content();
  if (isIndeedChallengeHtml(html)) return true;
  return /security check/i.test(await page.title());
}

async function readIndeedJdFromPage(page: Page): Promise<string | null> {
  if (await indeedPageLooksChallenged(page)) return null;
  await page
    .waitForSelector("#jobDescriptionText, [data-testid='jobsearch-JobComponent-description']", {
      timeout: 8_000,
    })
    .catch(() => {});
  if (await indeedPageLooksChallenged(page)) return null;
  const fromParser = extractIndeedDescriptionFromHtml(await page.content());
  if (fromParser && !isThinDiscoveryDescription(fromParser, "indeed")) return fromParser;
  const raw = await page.evaluate(() => {
    const candidates = [
      document.querySelector("#jobDescriptionText"),
      document.querySelector("[data-testid='jobsearch-JobComponent-description']"),
      document.querySelector(".jobsearch-JobComponent-description"),
      document.querySelector(".jobsearch-jobDescriptionText"),
      document.querySelector("#job-details"),
    ].filter((el): el is HTMLElement => el instanceof HTMLElement);
    for (const el of candidates) {
      const t = (el.innerText || "").trim();
      if (t.length > 120) return t.slice(0, 14_000);
    }
    return "";
  });
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length > 120 && !/security check/i.test(trimmed.slice(0, 400))) {
    if (!isThinDiscoveryDescription(trimmed, "indeed")) return trimmed;
  }
  return fromParser && fromParser.length > 120 ? fromParser : null;
}

async function warmIndeedSearchSession(
  page: Page,
  searchUrl: string | null,
  dismissCookies: boolean,
): Promise<boolean> {
  const url = searchUrl || `${INDEED_HU_ORIGIN}/jobs?q=developer&l=Budapest`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 75_000 });
  if (dismissCookies) {
    await dismissIndeedCookies(page);
    await sleep(500);
  } else {
    await sleep(250);
  }
  if (await indeedPageLooksChallenged(page)) return false;
  await page
    .waitForSelector("a[data-jk], .job_seen_beacon, #mosaic-provider-jobcards", { timeout: 10_000 })
    .catch(() => {});
  return !(await indeedPageLooksChallenged(page));
}

async function openIndeedJdOnSerp(page: Page, jk: string, searchUrl: string | null): Promise<string | null> {
  if (await indeedPageLooksChallenged(page)) return null;
  try {
    await page.locator(`a[data-jk="${jk}"]`).first().click({ timeout: 4000 });
    await sleep(450);
    const fromClick = await readIndeedJdFromPage(page);
    if (fromClick) return fromClick;
  } catch {
    /* card not on this SERP page */
  }
  if (await indeedPageLooksChallenged(page)) return null;
  await page.goto(indeedSerpVjkOnSearchUrl(searchUrl, jk), { waitUntil: "domcontentloaded", timeout: 75_000 });
  await sleep(400);
  return readIndeedJdFromPage(page);
}

async function hydrateIndeedJobsFromSerpPanel(page: Page, jobs: DiscoveredJob[], cap: number): Promise<void> {
  for (let i = 0; i < Math.min(cap, jobs.length); i += 1) {
    const job = jobs[i];
    const jk = indeedJkFromJobUrl(job.url);
    if (!jk) continue;
    const searchUrl = indeedSearchUrlFromListingBlurb(job.description ?? "");
    try {
      const detailText = await openIndeedJdOnSerp(page, jk, searchUrl);
      if (detailText && !isThinDiscoveryDescription(detailText, "indeed")) {
        job.description = detailText;
      } else if (await indeedPageLooksChallenged(page)) {
        break;
      }
    } catch {
      if (await indeedPageLooksChallenged(page)) break;
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
 * Catalog / eval hydrate: one browser, warm the listing search, then click cards / `q&vjk=`.
 * Isolated `/viewjob` and cold `jobs?vjk=` hit Indeed Security Check.
 * Mutates `jobs` in place when a JD is found.
 */
export async function hydrateIndeedJobsViaSerpVjk(jobs: DiscoveredJob[]): Promise<number> {
  const targets = jobs.filter((j) => j.provider === "indeed" && indeedJkFromJobUrl(j.url));
  if (targets.length === 0) return 0;

  const groups = new Map<string, DiscoveredJob[]>();
  for (const job of targets) {
    const key = indeedSearchUrlFromListingBlurb(job.description ?? "") ?? "";
    const arr = groups.get(key) ?? [];
    arr.push(job);
    groups.set(key, arr);
  }

  await progressCatalogHydrate({
    index: 0,
    total: targets.length,
    filled: 0,
    launching: true,
  }).catch(() => {});

  const { browser, page } = await openIndeedPlaywrightSession();
  let hydrated = 0;
  let processed = 0;
  try {
    let dismissCookies = true;
    let stop = false;
    for (const [searchKey, group] of groups) {
      if (stop) break;
      const searchUrl = searchKey || null;
      const warmed = await warmIndeedSearchSession(page, searchUrl, dismissCookies);
      dismissCookies = false;
      if (!warmed) {
        console.warn("[indeedCatalogHydrate] Security Check; skipping remaining catalog hydrate");
        break;
      }
      for (const job of group) {
        processed += 1;
        const jk = indeedJkFromJobUrl(job.url);
        await progressCatalogHydrate({
          index: processed,
          total: targets.length,
          filled: hydrated,
          title: job.title,
        }).catch(() => {});
        if (!jk) continue;
        try {
          const detailText = await openIndeedJdOnSerp(page, jk, searchUrl);
          if (detailText && !isThinDiscoveryDescription(detailText, "indeed")) {
            job.description = detailText;
            hydrated += 1;
          } else if (await indeedPageLooksChallenged(page)) {
            console.warn("[indeedCatalogHydrate] Security Check; skipping remaining catalog hydrate");
            stop = true;
            break;
          }
        } catch {
          /* next job */
        }
      }
    }
  } finally {
    await progressCatalogHydrate({
      index: targets.length,
      total: targets.length,
      filled: hydrated,
      done: true,
    }).catch(() => {});
    await browser.close().catch(() => {});
  }
  return hydrated;
}
