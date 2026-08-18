// lib/discovery/sources/jobDetailPlaywright.ts — Playwright fallback when HTTP detail fetch is blocked or empty.
import { chromium, type Page } from "playwright";
import type { DiscoveryProviderId } from "../../../types/discovery";
import { extractIndeedDescriptionFromHtml, isIndeedChallengeHtml } from "./indeedDetailParse";
import { extractProfessionDescriptionFromHtml } from "./professionDetailParse";
import {
  extractLinkedInDescriptionFromHtml,
  isLikelyLinkedInAuthWall,
} from "./linkedinDetailParse";
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
    'button:has-text("Elfogad")',
    'button:has-text("Összes elfogadása")',
  ];
  for (const sel of candidates) {
    try {
      await page.locator(sel).first().click({ timeout: 2500 });
      await sleep(400);
      return;
    } catch {
      /* next */
    }
  }
}

export async function fetchJobDetailBodyPlaywright(
  detailUrl: string,
  provider: DiscoveryProviderId,
): Promise<string | null> {
  const launchOpts: Parameters<typeof chromium.launch>[0] = {
    headless: true,
    args: STEALTH_CHROMIUM_ARGS,
  };
  if (process.env.ELIZA_PLAYWRIGHT_CHROME_CHANNEL === "chrome") {
    launchOpts.channel = "chrome";
  }

  const browser = await chromium.launch(launchOpts);
  try {
    const page = await browser.newPage({
      userAgent: UA,
      viewport: { width: 1365, height: 900 },
      locale: provider === "indeed" ? "hu-HU" : "hu-HU",
      timezoneId: "Europe/Budapest",
    });
    await initNavigatorWebdriverPatch(page);
    await wiggleMouse(page);
    await humanPause(400, 1200);
    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await humanPause(600, 1400);

    if (provider === "indeed") {
      await dismissIndeedCookies(page);
      await sleep(800);
      await page
        .waitForSelector("#jobDescriptionText, [data-testid='jobsearch-JobComponent-description']", {
          timeout: 12_000,
        })
        .catch(() => {});
      const title = await page.title();
      if (/security check/i.test(title)) return null;
    }

    const html = await page.content();
    if (provider === "indeed" && isIndeedChallengeHtml(html)) return null;
    const fromParser =
      provider === "indeed"
        ? extractIndeedDescriptionFromHtml(html)
        : provider === "profession"
          ? extractProfessionDescriptionFromHtml(html)
          : provider === "linkedin"
            ? extractLinkedInDescriptionFromHtml(html)
            : null;
    if (fromParser && fromParser.length > 80) return fromParser;

    const raw = await page.evaluate(() => {
      const candidates = [
        document.querySelector(".show-more-less-html__markup"),
        document.querySelector(".description__text"),
        document.querySelector("#jobDescriptionText"),
        document.querySelector("article"),
        document.querySelector('[class*="job-description"]'),
        document.querySelector('[class*="JobDescription"]'),
        document.querySelector("main"),
        document.body,
      ].filter((el): el is HTMLElement => el instanceof HTMLElement);
      for (const el of candidates) {
        const t = (el.innerText || "").trim();
        if (t.length > 120) return t.slice(0, 14000);
      }
      return "";
    });
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (provider === "linkedin" && isLikelyLinkedInAuthWall(trimmed)) return null;
    if (provider === "indeed" && /security check/i.test(trimmed.slice(0, 400))) return null;
    return trimmed.length > 80 ? trimmed.slice(0, 14_000) : null;
  } finally {
    await browser.close().catch(() => {});
  }
}
