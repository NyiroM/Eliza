// lib/discovery/sources/professionHuPlaywright.ts
import { chromium, type Browser, type Locator, type Page } from "playwright";
import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import type { DiscoveredJob, DiscoveryProviderId } from "../../../types/discovery";
import {
  saveDiscoveryDomSnapshot,
  saveDiscoveryProgressScreenshot,
  saveDiscoveryZeroResultScreenshot,
} from "../debugScreenshot";
import { humanPause, initNavigatorWebdriverPatch, randomBetween, STEALTH_CHROMIUM_ARGS, wiggleMouse } from "../playwrightStealth";
import {
  clickProfessionHungarianAcceptAllCookies,
  dismissObstructingModalsDynamic,
  dismissProfessionHuOverlays,
} from "./professionHuDialogs";
import { stableJobId } from "../id";
import {
  professionHuLocationSlugFromPreference,
  professionSearchNavigationFailureReason,
  isProfessionJobListingHref,
} from "../professionHuUrlValidation";
import { nuclearProfessionHuModalClearance } from "./professionHuNuclear";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const LISTING_ENTRY_NATIONAL = "https://www.profession.hu/allasok/1";

function professionListingFallbackEntry(preferredLocation: string | null | undefined): string {
  const slug = professionHuLocationSlugFromPreference(preferredLocation);
  if (slug) return `https://www.profession.hu/allasok/${slug}/1`;
  return LISTING_ENTRY_NATIONAL;
}

/**
 * Hard cap for the entire Profession.hu Playwright fetch (navigation, settle, listing, detail sampling).
 * Listing-only path (default, details at eval) usually finishes well under this; HTTP fallback runs if it trips.
 */
const FETCH_OVERALL_TIMEOUT_MS = Number(process.env.ELIZA_PROFESSION_FETCH_TIMEOUT_MS) || 90_000;

/** Shorter waits between listing steps. Default on; set `ELIZA_PROFESSION_FAST_NAV=0` for slower/stealth typing. */
const PROFESSION_FAST_NAV = process.env.ELIZA_PROFESSION_FAST_NAV !== "0";
/**
 * One nuclear pass, shorter settle, no progress PNGs around nuclear.
 * Default on for speed; set `ELIZA_PROFESSION_LITE_SETTLE=0` for legacy double-nuclear + screenshots.
 */
const PROFESSION_LITE_SETTLE = process.env.ELIZA_PROFESSION_LITE_SETTLE !== "0";

function sleepNav(ms: number): Promise<void> {
  const t = PROFESSION_FAST_NAV ? Math.max(350, Math.floor(ms * 0.55)) : ms;
  return sleep(t);
}

/** Settle timing: `lite` uses shorter waits; fast nav scales both down slightly. */
function settleSleep(normalMs: number, liteMs: number): Promise<void> {
  let m = PROFESSION_LITE_SETTLE ? liteMs : normalMs;
  if (PROFESSION_FAST_NAV) m = Math.max(180, Math.floor(m * 0.62));
  return sleep(m);
}

function phLog(step: string, detail?: string): void {
  if (process.env.ELIZA_PROFESSION_PLAYWRIGHT_DEBUG !== "1") return;
  console.log(`[profession.hu] ${step}${detail !== undefined && detail !== "" ? `: ${detail}` : ""}`);
}

function isProfessionHuFetchTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "ProfessionHuFetchTimeoutError";
}

function createOverallDeadline(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`Profession.hu fetch exceeded ${ms}ms (overall limit)`);
      e.name = "ProfessionHuFetchTimeoutError";
      reject(e);
    }, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

async function saveTimeoutArtifacts(page: Page, keywordLabel: string): Promise<void> {
  const label = `${keywordLabel}-timeout`;
  await saveDiscoveryDomSnapshot("profession", page, label).catch(() => {});
  await saveDiscoveryProgressScreenshot("profession", page, label).catch(() => {});
}

async function runNuclearWithProgressShots(page: Page, phase: string): Promise<void> {
  if (PROFESSION_LITE_SETTLE) {
    phLog("Running nuclearProfessionHuModalClearance (lite: no progress screenshots)", phase);
    await nuclearProfessionHuModalClearance(page);
    phLog("Modal cleared (nuclear pass done)", phase);
    return;
  }
  phLog("Screenshot before nuclear", phase);
  await saveDiscoveryProgressScreenshot("profession", page, `before-nuclear-${phase}`).catch(() => {});
  phLog("Running nuclearProfessionHuModalClearance", phase);
  await nuclearProfessionHuModalClearance(page);
  phLog("Screenshot after nuclear", phase);
  await saveDiscoveryProgressScreenshot("profession", page, `after-nuclear-${phase}`).catch(() => {});
  phLog("Modal cleared (nuclear pass done)", phase);
}

const SEARCH_INPUT_SELECTORS = [
  "input#header_keyword",
  'input[name="adv_pattern"]',
  'input[name="keyword"]',
  "input#keyword",
  'input[placeholder*="állás" i]',
  'input[placeholder*="munkakör" i]',
  'input[placeholder*="Keres" i]',
  'input[placeholder*="keres" i]',
  'header input[type="search"]',
  'header input[type="text"]',
  '[class*="search" i] input[type="text"]',
  'form[action*="allas"] input[name="keyword"]',
  'input[type="search"]',
];

function professionKeywordUrlVariants(keyword: string, locationSlug: string | null): string[] {
  const raw = (keyword.trim() || "fejlesztő").normalize("NFC");
  const out: string[] = [];
  if (locationSlug) {
    const loc = new URL(`https://www.profession.hu/allasok/${locationSlug}/1`);
    loc.searchParams.set("adv_pattern", raw);
    out.push(loc.toString());
  }
  const national = new URL("https://www.profession.hu/allasok/1");
  national.searchParams.set("adv_pattern", raw);
  out.push(national.toString());
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shouldRankListingTitles(keyword: string): boolean {
  return keyword.trim().length >= 3;
}

/** Tokens derived from the search phrase (for slug/title plausibility, not generic “bait” lists). */
function significantSearchTokens(keyword: string): string[] {
  const raw = keyword.normalize("NFC").trim().toLowerCase();
  const parts = raw.split(/[^a-z0-9áéíóöőúüű]+/i).filter((p) => p.length >= 3);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.slice(0, 12);
}

function jobPathSlugSegment(url: string): string {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/allas\/(.+)/i);
    return (m?.[1] ?? "").toLowerCase();
  } catch {
    return "";
  }
}

/** Only the head of the ranked list (what the user sees first) must match — deeper rows can still mention e.g. "engineer" by chance. */
const LISTING_PLAUSIBILITY_HEAD = 8;

/**
 * True when at least one of the first ranked rows plausibly belongs to this search.
 * Uses full-token containment on slug segments only (no `tok.includes(shortSegment)` — that caused false positives).
 */
function listingPlausiblyMatchesSearch(
  keyword: string,
  cards: { url: string; title: string }[],
): boolean {
  const tokens = significantSearchTokens(keyword);
  if (tokens.length === 0) return true;
  const sample = cards.slice(0, Math.min(LISTING_PLAUSIBILITY_HEAD, cards.length));
  for (const c of sample) {
    const slug = jobPathSlugSegment(c.url);
    const title = c.title.normalize("NFC").trim().toLowerCase();
    for (const tok of tokens) {
      if (title.includes(tok)) return true;
      if (slug.length < 3) continue;
      if (slug.includes(tok)) return true;
      const segs = slug.split("-").filter((s) => s.length >= 3);
      for (const s of segs) {
        if (s.includes(tok)) return true;
      }
    }
  }
  return false;
}

/** Order cards by keyword overlap only (no title-based “bait” heuristics). */
function listingTitleScore(keyword: string, title: string): number {
  const t = title.toLowerCase();
  let s = 0;
  for (const part of keyword.toLowerCase().split(/\s+/)) {
    if (part.length > 2 && t.includes(part)) s += 2;
  }
  return s;
}

function rankJobCardsForKeyword(
  keyword: string,
  cards: { url: string; title: string }[],
  maxOut: number,
): { url: string; title: string }[] {
  if (!shouldRankListingTitles(keyword) || cards.length <= maxOut) {
    return cards.slice(0, maxOut);
  }
  const scored = cards.map((c, i) => ({ c, score: listingTitleScore(keyword, c.title), i }));
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.i - b.i));
  return scored.map((x) => x.c).slice(0, maxOut);
}

function collectJobLinksFromCheerio(
  $: CheerioAPI,
  scope: Cheerio<AnyNode>,
  maxCollect: number,
): { url: string; title: string }[] {
  const cards: { url: string; title: string }[] = [];
  const seen = new Set<string>();

  scope.find('a[href*="/allas/"]').each((_, a) => {
    if (cards.length >= maxCollect) return false;
    const href = $(a).attr("href")?.trim();
    if (!href || !isProfessionJobListingHref(href)) return;
    const abs = href.startsWith("http")
      ? href
      : `https://www.profession.hu${href.startsWith("/") ? "" : "/"}${href}`;
    const pathOnly = abs.split("?")[0];
    if (seen.has(pathOnly)) return;
    seen.add(pathOnly);
    const $a = $(a);
    const dataName = $a.attr("data-item-name")?.trim();
    const title = (dataName || $a.text().trim() || $a.attr("title")?.trim() || "Job").slice(0, 300);
    if (title.length < 2) return;
    cards.push({ url: pathOnly, title });
    return undefined;
  });

  return cards;
}

function parseListingCardsScoped(
  html: string,
  maxListings: number,
  keyword: string,
): { cards: { url: string; title: string }[]; titles: string[] } {
  const maxCollect = Math.min(140, Math.max(maxListings * 8, 48));
  const $ = cheerio.load(html);
  const main = $("main");
  let cards = main.length ? collectJobLinksFromCheerio($, main, maxCollect) : [];
  if (cards.length < 8) {
    const body = $("body");
    const wide = collectJobLinksFromCheerio($, body.length ? body : $.root(), maxCollect);
    const byUrl = new Map<string, { url: string; title: string }>();
    for (const c of cards) byUrl.set(c.url, c);
    for (const c of wide) {
      if (!byUrl.has(c.url)) byUrl.set(c.url, c);
    }
    cards = [...byUrl.values()];
  }
  cards = rankJobCardsForKeyword(keyword, cards, maxListings);
  return { cards, titles: cards.map((c) => c.title) };
}

async function trySubmitSearchForm(page: Page, keyword: string): Promise<boolean> {
  phLog("Attempting native form submit (searchbar_form / adv_pattern)");
  const body = `
    var input = document.querySelector(
      'input[name="adv_pattern"], input#header_keyword, input[name="keyword"], input#keyword, input[type="search"]',
    );
    var form = document.querySelector("#searchbar_form") || (input && input.form) ||
      document.querySelector('form[action*="allas" i], form[action*="Allas"]');
    if (!input || !form) return false;
    var desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    if (desc && desc.set) desc.set.call(input, kw);
    else input.value = kw;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
    return true;
  `;
  const ok = await page.evaluate(new Function("kw", body) as (kw: string) => boolean, keyword);
  if (ok) {
    phLog("Form submitted — saving screenshot immediately (POST submit, not Enter)");
    await saveDiscoveryProgressScreenshot("profession", page, "after-form-submit-listing").catch(() => {});
  } else {
    phLog("Form submit skipped (input or form not found)");
  }
  return ok;
}

async function findSearchInput(page: Page): Promise<Locator | null> {
  for (const sel of SEARCH_INPUT_SELECTORS) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: "visible", timeout: 3500 });
      return loc;
    } catch {
      /* next */
    }
  }
  return null;
}

async function typeKeywordHuman(loc: Locator, keyword: string): Promise<void> {
  for (const ch of keyword) {
    if (ch === "\n" || ch === "\r") continue;
    await loc.type(ch, { delay: randomBetween(PROFESSION_FAST_NAV ? 25 : 100, PROFESSION_FAST_NAV ? 70 : 500) });
  }
}

async function injectSearchAndEnter(page: Page, keyword: string): Promise<void> {
  phLog("Injecting keyword + synthetic Enter (evaluate)");
  const body = `
    var el = document.querySelector(
      'input[name="adv_pattern"], input#header_keyword, input[name="keyword"], input#keyword, input[type="search"]',
    );
    if (!el) return;
    el.focus();
    var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    if (d && d.set) d.set.call(el, kw); else el.value = kw;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  `;
  await page.evaluate(new Function("kw", body) as (kw: string) => void, keyword);
  phLog("Synthetic Enter dispatched — saving screenshot immediately");
  await saveDiscoveryProgressScreenshot("profession", page, "after-enter-inject-listing").catch(() => {});
}

async function performProfessionListingSearch(page: Page, keyword: string): Promise<void> {
  phLog("Typed listing search: locating search input");
  const input = await findSearchInput(page);
  if (!input) {
    phLog("No visible search input — inject + Enter fallback");
    await injectSearchAndEnter(page, keyword);
    await sleepNav(900);
    phLog("Waiting networkidle (inject path, capped)");
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await humanPause(300, 700);
    return;
  }

  phLog("Search input found — focusing and clearing");
  try {
    await input.scrollIntoViewIfNeeded();
    await humanPause(100, 400);
    await input.click({ timeout: 9000 });
  } catch {
    await input.click({ force: true, timeout: 9000 });
  }

  await humanPause(120, 380);
  try {
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
  } catch {
    await input.fill("");
  }
  await humanPause(80, 220);

  phLog("Typing keyword");
  try {
    await typeKeywordHuman(input, keyword);
  } catch {
    await input.fill(keyword);
  }

  await humanPause(150, 450);
  phLog("Pressing Enter (listing search)");
  try {
    await input.press("Enter");
  } catch {
    await page.keyboard.press("Enter");
  }
  phLog("Enter key pressed — saving screenshot immediately (before URL/network waits)");
  await saveDiscoveryProgressScreenshot("profession", page, "after-enter-typed-listing").catch(() => {});

  await sleepNav(500);
  phLog("Waiting for URL change (search params)");
  await page.waitForURL(/adv_pattern=|keyword=|kulcssz|search=|keywordsearch|\d+,\d+,\d+,/i, {
    timeout: PROFESSION_FAST_NAV ? 8_000 : 12_000,
  }).catch(() => {});
  phLog("Waiting networkidle (typed path, capped)");
  await page.waitForLoadState("networkidle", { timeout: PROFESSION_FAST_NAV ? 7_000 : 10_000 }).catch(() => {});
  await humanPause(400, 900);
  phLog("Typed listing search step finished");
}

async function scrollListingWarmup(page: Page): Promise<void> {
  phLog("Listing scroll warmup");
  await page.evaluate(() => window.scrollBy(0, 480));
  await humanPause(280, 620);
  await page.evaluate(() => window.scrollBy(0, -320));
  await humanPause(200, 480);
  await wiggleMouse(page);
}

async function settleAfterNavigation(page: Page, settleTag: string, light = false): Promise<void> {
  if (light) {
    phLog("Settle: light (reused session)", settleTag);
    await clickProfessionHungarianAcceptAllCookies(page);
    await dismissProfessionHuOverlays(page);
    await dismissObstructingModalsDynamic(page);
    await settleSleep(250, 120);
    return;
  }
  const lite = PROFESSION_LITE_SETTLE;
  phLog("Settle: wait for cookie / CMP paint", settleTag);
  await settleSleep(550, 320);
  phLog("Settle: Hungarian accept-all cookies (before nuclear)", settleTag);
  const nCookie = await clickProfessionHungarianAcceptAllCookies(page);
  phLog("Settle: Hungarian cookie clicks", String(nCookie));
  phLog("Settle: overlay selectors + dynamic modals (pre-nuclear)", settleTag);
  await dismissProfessionHuOverlays(page);
  await dismissObstructingModalsDynamic(page);
  await settleSleep(250, 120);
  phLog("Settle: first nuclear pass", settleTag);
  await runNuclearWithProgressShots(page, `${settleTag}-pass1`);
  phLog("Settle: dynamic modals after nuclear 1", settleTag);
  await dismissObstructingModalsDynamic(page);
  if (!lite) {
    await settleSleep(200, 100);
    phLog("Settle: second nuclear pass", settleTag);
    await runNuclearWithProgressShots(page, `${settleTag}-pass2`);
  } else {
    phLog("Settle: skipping second nuclear (ELIZA_PROFESSION_LITE_SETTLE=1)", settleTag);
  }
  phLog("Settle: final Hungarian cookie + light overlays", settleTag);
  await clickProfessionHungarianAcceptAllCookies(page);
  await dismissProfessionHuOverlays(page);
  await dismissObstructingModalsDynamic(page);
  phLog("Settle: waiting networkidle (capped)");
  await page.waitForLoadState("networkidle", { timeout: lite ? 6_500 : 10_000 }).catch(() => {});
  await settleSleep(600, 280);
  phLog("Settle complete", settleTag);
}

export type ProfessionHuPlaywrightSession = {
  browser: Browser;
  page: Page;
  listingsDone?: number;
};

export async function openProfessionHuPlaywrightSession(): Promise<ProfessionHuPlaywrightSession> {
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
    locale: "hu-HU",
    viewport: { width: 1365, height: 900 },
    timezoneId: "Europe/Budapest",
  });
  await initNavigatorWebdriverPatch(page);
  await wiggleMouse(page);
  await humanPause(PROFESSION_FAST_NAV ? 200 : 400, PROFESSION_FAST_NAV ? 550 : 1200);
  return { browser, page };
}

/**
 * Tier B: Profession.hu — direct keyword URLs + soft overlays + main-scoped parse (avoids killing the search shell).
 * Enforces {@link FETCH_OVERALL_TIMEOUT_MS} for the whole run; on expiry saves DOM + PNG and throws.
 */
export async function fetchProfessionHuJobsPlaywright(
  keywords: string,
  maxListings = 20,
  maxDetailVisits = 8,
  preferredLocation?: string | null,
  session?: ProfessionHuPlaywrightSession,
): Promise<DiscoveredJob[]> {
  const listKw = keywords.trim() || "fejlesztő";
  const locSlug = professionHuLocationSlugFromPreference(preferredLocation);
  const urlVariants = professionKeywordUrlVariants(listKw, locSlug);
  const provider: DiscoveryProviderId = "profession";

  phLog("Starting fetchProfessionHuJobsPlaywright", listKw);
  phLog(`Overall deadline ${FETCH_OVERALL_TIMEOUT_MS}ms (cookie/settle can be heavy; navigation + listing + details)`);
  if (PROFESSION_FAST_NAV) {
    phLog("Speed: ELIZA_PROFESSION_FAST_NAV=1 (shorter sleeps / waits)");
  }

  const navTimeout = Math.min(28_000, Math.floor(FETCH_OVERALL_TIMEOUT_MS / 2));
  const refs: { browser: Browser | null; page: Page | null } = { browser: null, page: null };
  const { promise: overallTimeout, cancel: cancelOverallTimeout } = createOverallDeadline(FETCH_OVERALL_TIMEOUT_MS);
  const reuseSession = Boolean(session);

  const run = async (): Promise<DiscoveredJob[]> => {
    const owned = session ?? (await openProfessionHuPlaywrightSession());
    const browser = owned.browser;
    const page = owned.page;
    refs.browser = browser;
    refs.page = page;
    const lightSettle = Boolean(session?.listingsDone);
    try {
      const professionRunT0 = Date.now();

      let cards: { url: string; title: string }[] = [];
      let titles: string[] = [];
      let navigationUrlValidated = false;

      for (let vi = 0; vi < urlVariants.length; vi += 1) {
        const listingUrl = urlVariants[vi];
        phLog(`Goto listing variant ${vi + 1}/${urlVariants.length}`, listingUrl);
        await page.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: navTimeout });
        phLog("Post-goto: quick URL check before heavy settle (fail fast on bare /allasok redirect)");
        await sleepNav(lightSettle ? 400 : 1100);
        await clickProfessionHungarianAcceptAllCookies(page);
        if (!lightSettle) await sleepNav(400);
        const urlFail = professionSearchNavigationFailureReason(page.url(), listKw);
        if (urlFail) {
          phLog(`URL validation failed pre-settle (variant ${vi + 1})`, `${urlFail} — ${page.url()}`);
          continue;
        }

        phLog(lightSettle ? "URL bar OK — light settle + parse" : "URL bar OK — full settle + parse");
        if (!lightSettle) await sleepNav(800);
        await settleAfterNavigation(page, `listing-url-${vi}`, lightSettle);
        if (!lightSettle) await scrollListingWarmup(page);

        const afterVariant = professionSearchNavigationFailureReason(page.url(), listKw);
        if (afterVariant) {
          phLog(`URL validation failed post-settle (variant ${vi + 1})`, `${afterVariant} — ${page.url()}`);
          continue;
        }

        const parsed = parseListingCardsScoped(await page.content(), maxListings, listKw);
        titles = parsed.titles;
        cards = parsed.cards;
        if (cards.length > 0 && !listingPlausiblyMatchesSearch(listKw, cards)) {
          phLog(
            "Listing rows/slugs do not match search phrase (unrelated SERP despite URL params) — next variant",
            titles.slice(0, 4).join(" | ") || "(no titles)",
          );
          continue;
        }
        navigationUrlValidated = true;
        phLog(`URL + listing OK; ${cards.length} cards, sample: ${titles.slice(0, 3).join(" | ") || "(none)"}`);
        break;
      }

      if (!navigationUrlValidated) {
        phLog("Direct URL variants exhausted — skipping typed-search fallback (HTTP path runs next)");
        if (process.env.ELIZA_PROFESSION_TYPED_SEARCH === "1") {
          phLog("Typed-search fallback enabled (ELIZA_PROFESSION_TYPED_SEARCH=1)");
          await page.goto(professionListingFallbackEntry(preferredLocation), {
            waitUntil: "domcontentloaded",
            timeout: navTimeout,
          });
          await sleepNav(800);
          await settleAfterNavigation(page, "fallback-base", lightSettle);
          await performProfessionListingSearch(page, listKw);
          await scrollListingWarmup(page);
          if (professionSearchNavigationFailureReason(page.url(), listKw) && (await trySubmitSearchForm(page, listKw))) {
            await sleepNav(800);
            await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
          }
          const parsedFb = parseListingCardsScoped(await page.content(), maxListings, listKw);
          cards = parsedFb.cards;
          titles = parsedFb.titles;
          if (
            !professionSearchNavigationFailureReason(page.url(), listKw) &&
            (cards.length === 0 || listingPlausiblyMatchesSearch(listKw, cards))
          ) {
            navigationUrlValidated = true;
          }
        }
      }

      if (cards.length === 0) {
        phLog("Zero cards — zero-result screenshot");
        await saveDiscoveryZeroResultScreenshot("profession", page, listKw);
      }

      const jobs: DiscoveredJob[] = [];
      const detailCap = Math.min(maxDetailVisits, cards.length);
      phLog(`Building job list (detail visits cap: ${detailCap})`);
      const detailBudgetUntil = professionRunT0 + FETCH_OVERALL_TIMEOUT_MS - 22_000;

      for (let i = 0; i < cards.length; i += 1) {
        const { url, title } = cards[i];
        let description = `${title}\nListing: ${page.url()}`;

        if (i < detailCap && Date.now() < detailBudgetUntil) {
          try {
            phLog(`Detail fetch ${i + 1}/${detailCap}`, url);
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeout });
            await sleepNav(500);
            await clickProfessionHungarianAcceptAllCookies(page);
            await runNuclearWithProgressShots(page, `detail-${i}`);
            phLog("Detail: overlays");
            await dismissProfessionHuOverlays(page);
            await dismissObstructingModalsDynamic(page);
            await sleepNav(400);
            const detailJs = `
            var candidates = [
              document.querySelector("article"),
              document.querySelector('[class*="job"]'),
              document.querySelector("main"),
              document.body,
            ].filter(Boolean);
            var el = candidates[0];
            var t = (el && el.innerText ? el.innerText : "").trim();
            return t.slice(0, 12000);
          `;
            const detailText = await page.evaluate(new Function(detailJs) as () => string);
            if (detailText.length > 120) {
              description = detailText;
            }
            phLog(`Detail text length: ${description.length}`);
          } catch {
            /* keep listing fallback description */
          }
        } else if (i < detailCap) {
          phLog(`Detail fetch skipped ${i + 1}/${detailCap} (overall time budget) — listing blurb only`);
        }

        jobs.push({
          id: stableJobId(provider, url),
          provider,
          title,
          company: null,
          url,
          description,
          discovered_at: new Date().toISOString(),
        });
      }

      phLog(`Fetch complete: ${jobs.length} jobs`);
      return jobs;
    } finally {
      if (session) session.listingsDone = (session.listingsDone ?? 0) + 1;
      if (!reuseSession) {
        phLog("Closing browser (run inner finally)");
        await browser.close().catch(() => {});
        refs.browser = null;
        refs.page = null;
      }
    }
  };

  try {
    const jobs = await Promise.race([run(), overallTimeout]);
    phLog("Finished within overall deadline");
    return jobs;
  } catch (err) {
    if (isProfessionHuFetchTimeout(err)) {
      phLog("OVERALL TIMEOUT — saving DOM snapshot + screenshot from current page (if any)");
      const { page: timeoutPage, browser: timeoutBrowser } = refs;
      if (timeoutPage) {
        await saveTimeoutArtifacts(timeoutPage, listKw);
      } else {
        phLog("No page handle yet — skipping DOM/screenshot");
      }
      if (timeoutBrowser) {
        phLog(reuseSession ? "Closing reused browser after timeout (caller must reopen)" : "Closing browser after timeout");
        await timeoutBrowser.close().catch(() => {});
        refs.browser = null;
        refs.page = null;
      }
    }
    throw err;
  } finally {
    cancelOverallTimeout();
  }
}
