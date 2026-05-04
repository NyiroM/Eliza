// lib/discovery/sources/indeedPlaywright.ts — Hungary Indeed job search via Playwright (RSS replacement).
import { chromium, type Page } from "playwright";
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { DiscoveredJob, DiscoveryProviderId } from "../../../types/discovery";
import { saveDiscoveryZeroResultScreenshot } from "../debugScreenshot";
import { stableJobId } from "../id";
import { resolveIndeedJobUrl } from "./indeedJobUrl";
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

function indeedSearchUrl(keywords: string): string {
  const q = keywords.trim() || "developer";
  return `https://hu.indeed.com/jobs?q=${encodeURIComponent(q)}&l=Hungary`;
}

const JOB_CARD_LINK_SELECTORS = [
  "#mosaic-provider-jobcards a[data-jk]",
  ".job_seen_beacon a[data-jk]",
] as const;

/**
 * Fetches job cards from Indeed Hungary using Playwright with light stealth patterns.
 */
export async function fetchIndeedJobsPlaywright(keywords: string, maxItems = 25): Promise<DiscoveredJob[]> {
  const listUrl = indeedSearchUrl(keywords);
  const launchOpts: Parameters<typeof chromium.launch>[0] = {
    headless: true,
    args: STEALTH_CHROMIUM_ARGS,
  };
  if (process.env.ELIZA_PLAYWRIGHT_CHROME_CHANNEL === "chrome") {
    launchOpts.channel = "chrome";
  }
  const browser = await chromium.launch(launchOpts);
  const provider: DiscoveryProviderId = "indeed";

  try {
    const page = await browser.newPage({
      userAgent: UA,
      viewport: { width: 1365, height: 900 },
      locale: "hu-HU",
      timezoneId: "Europe/Budapest",
    });
    await initNavigatorWebdriverPatch(page);
    await wiggleMouse(page);
    await humanPause(600, 1800);
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await humanPause(800, 2000);
    await wiggleMouse(page);
    await dismissIndeedCookies(page);
    await sleep(2000);
    await page.waitForSelector("a[data-jk], .job_seen_beacon, #mosaic-provider-jobcards", {
      timeout: 45_000,
    }).catch(() => {});

    const html = await page.content();
    const $ = cheerio.load(html);
    const out: DiscoveredJob[] = [];
    const seenJk = new Set<string>();

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
      const title = $(a).text().trim() || "Job";
      out.push({
        id: stableJobId(provider, url),
        provider,
        title: title.slice(0, 300),
        company: null,
        url,
        description: `${title}\nIndeed: ${listUrl}`,
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

    return out;
  } finally {
    await browser.close();
  }
}
