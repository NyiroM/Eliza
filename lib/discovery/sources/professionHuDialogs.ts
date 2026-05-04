// lib/discovery/sources/professionHuDialogs.ts — dismiss cookie / location overlays on profession.hu.
import type { Page } from "playwright";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const COOKIE_SELECTORS = [
  // Profession.hu / CMP — exact Hungarian "accept all cookies" (case variants).
  'button:has-text("ELFOGADOM AZ ÖSSZES SÜTIT")',
  'button:has-text("Elfogadom az összes sütit")',
  'button:has-text("Elfogadom az összes sütit")',
  'a:has-text("ELFOGADOM AZ ÖSSZES SÜTIT")',
  '[role="dialog"] >> button.ds-btn-primary',
  '[class*="cookie" i] >> button.ds-btn-primary',
  '[id*="CybotCookiebotDialog" i] button.ds-btn-primary',
  '[id*="cookie" i] button.ds-btn-primary',
  'button:has-text("Összes elfogadása")',
  'button:has-text("Elfogadom")',
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowall",
  ".fc-button-label:has-text(\"Consent\")",
  '[aria-label="Accept all cookies"]',
  '[data-testid="cookie-accept-all"]',
];

const LOCATION_OR_MISC = [
  'button:has-text("Kihagyás")',
  'button:has-text("Skip")',
  'button:has-text("Bezárás")',
  'button:has-text("Close")',
  '[aria-label="Close"]',
  ".modal__close",
];

async function tryClickFirst(page: Page, selector: string, timeout = 2200): Promise<boolean> {
  try {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: "visible", timeout });
    await loc.click({ timeout });
    await sleep(400);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clicks the large green "Elfogadom az összes sütit" / Cookiebot-style accept-all control
 * (text match in page + Playwright selectors).
 */
export async function clickProfessionHungarianAcceptAllCookies(page: Page): Promise<number> {
  let clicks = 0;
  const byText = `
    var re = /elfogadom\\s+az\\s+összes\\s+sütit/i;
    var nodes = document.querySelectorAll(
      "button, a[role='button'], [role='button'], input[type='button'], input[type='submit'], .ds-btn-primary, a.btn",
    );
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > window.innerHeight) continue;
      var t = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
      if (t.length > 160) continue;
      if (re.test(t)) {
        try { el.click(); return 1; } catch (e) { return 0; }
      }
    }
    return 0;
  `;
  try {
    const n = await page.evaluate(new Function(byText) as () => 0 | 1);
    if (n === 1) {
      clicks += 1;
      await sleep(500);
    }
  } catch {
    /* ignore */
  }
  for (const sel of COOKIE_SELECTORS.slice(0, 6)) {
    if (await tryClickFirst(page, sel, 700)) clicks += 1;
  }
  return clicks;
}

/**
 * Best-effort dismissal of Profession.hu cookie banners and location / interstitial modals.
 */
export async function dismissProfessionHuOverlays(page: Page): Promise<void> {
  await clickProfessionHungarianAcceptAllCookies(page);
  const prioritySelectors = [...COOKIE_SELECTORS.slice(0, 10), ...LOCATION_OR_MISC.slice(0, 5)];
  for (let round = 0; round < 2; round += 1) {
    let clicked = false;
    for (const sel of prioritySelectors) {
      if (await tryClickFirst(page, sel, 550)) {
        clicked = true;
        break;
      }
    }
    if (!clicked) break;
    await sleep(350);
  }
}

/**
 * Clicks visible buttons whose label suggests consent / close / skip (no hard-coded vendor IDs only).
 */
export async function dismissObstructingModalsDynamic(page: Page): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    const clickBody = `
      var re =
        /^(összes\\s+elfogad|elfogadom\\s+az\\s+összes\\s+sütit|elfogadom|accept\\s+all|i\\s+agree|consent|hozzájárul|rendben|ok$|bezár|close|dismiss|skip|kihagy|nem,?\\s*köszönöm|nem\\s+kell)/i;
      var nodes = Array.prototype.slice.call(
        document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit'], a.btn"),
      );
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > window.innerHeight) continue;
        var t = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
        if (t.length > 120) continue;
        if (re.test(t)) {
          el.click();
          return true;
        }
      }
      return false;
    `;
    const clicked = await page.evaluate(new Function(clickBody) as () => boolean);
    if (!clicked) break;
    await sleep(450);
  }
}
