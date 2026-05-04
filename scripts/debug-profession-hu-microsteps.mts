#!/usr/bin/env node
// scripts/debug-profession-hu-microsteps.mts — micro-step screenshots + overlay DOM notes for profession.hu search debugging.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { chromium, type Page } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const KEYWORD = process.env.DEBUG_KEYWORD?.trim() || "Software Engineer";
const LISTING = "https://www.profession.hu/allasok/1";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function shot(page: Page, dir: string, name: string): Promise<string> {
  const p = path.join(dir, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  return p;
}

async function overlayReport(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const out: {
      fullViewportFixed: { tag: string; id: string; className: string; z: string; pe: string; areaRatio: string }[];
      highZFixed: { tag: string; id: string; className: string; z: string; pe: string; rect: DOMRect }[];
      listenersGuess: { tag: string; id: string; note: string }[];
    } = {
      fullViewportFixed: [],
      highZFixed: [],
      listenersGuess: [],
    };

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    document.querySelectorAll("body *").forEach((el) => {
      const h = el as HTMLElement;
      const st = window.getComputedStyle(h);
      if (st.position !== "fixed" || st.pointerEvents === "none") return;
      const r = h.getBoundingClientRect();
      const area = (r.width * r.height) / (vw * vh);
      const z = parseInt(st.zIndex, 10);
      if (area >= 0.55 && Number.isFinite(z) && z > 500 && out.fullViewportFixed.length < 12) {
        out.fullViewportFixed.push({
          tag: h.tagName,
          id: h.id || "",
          className: typeof h.className === "string" ? h.className.slice(0, 120) : "",
          z: st.zIndex,
          pe: st.pointerEvents,
          areaRatio: area.toFixed(2),
        });
      }
    });

    document.querySelectorAll("body *").forEach((el) => {
      const h = el as HTMLElement;
      const st = window.getComputedStyle(h);
      if (st.position !== "fixed" && st.position !== "sticky") return;
      const z = parseInt(st.zIndex, 10);
      if (!Number.isFinite(z) || z < 2000) return;
      const r = h.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return;
      if (out.highZFixed.length < 35) {
        out.highZFixed.push({
          tag: h.tagName,
          id: h.id || "",
          className: typeof h.className === "string" ? h.className.slice(0, 120) : "",
          z: st.zIndex,
          pe: st.pointerEvents,
          rect: r.toJSON?.() ?? { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left },
        });
      }
    });

    ["header", "main", "dialog", '[role="dialog"]'].forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        const h = el as HTMLElement;
        if (out.listenersGuess.length >= 20) return;
        out.listenersGuess.push({
          tag: h.tagName,
          id: h.id || "",
          note: "getEventListeners not available in page; flagging interactive containers only",
        });
      });
    });

    return out;
  });
}

async function trySubmitSearchForm(page: Page, keyword: string): Promise<boolean> {
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
  return page.evaluate(new Function("kw", body) as (kw: string) => boolean, keyword);
}

async function main(): Promise<void> {
  const libDiscovery = new URL("../lib/discovery/", import.meta.url).href;
  const { humanPause, initNavigatorWebdriverPatch, STEALTH_CHROMIUM_ARGS, wiggleMouse } = await import(
    new URL("playwrightStealth", libDiscovery).href,
  );
  const { dismissObstructingModalsDynamic, dismissProfessionHuOverlays } = await import(
    new URL("sources/professionHuDialogs", libDiscovery).href,
  );
  const { nuclearProfessionHuModalClearance } = await import(new URL("sources/professionHuNuclear", libDiscovery).href);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(repoRoot, "storage", "debug", `profession-microsteps-${stamp}`);
  await fs.mkdir(outDir, { recursive: true });

  const headed = process.env.DEBUG_HEADED === "1";
  const browser = await chromium.launch({
    headless: !headed,
    args: STEALTH_CHROMIUM_ARGS,
    channel: process.env.ELIZA_PLAYWRIGHT_CHROME_CHANNEL === "chrome" ? "chrome" : undefined,
  });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "hu-HU",
    viewport: { width: 1365, height: 900 },
    timezoneId: "Europe/Budapest",
  });
  await initNavigatorWebdriverPatch(page);
  await wiggleMouse(page);

  const log: string[] = [];

  try {
    await page.goto(LISTING, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(2000);
    log.push(await shot(page, outDir, "01-initial-load"));

    const beforeModal = await overlayReport(page);
    await fs.writeFile(path.join(outDir, "overlay-01-initial.json"), JSON.stringify(beforeModal, null, 2), "utf8");

    await nuclearProfessionHuModalClearance(page);
    await dismissProfessionHuOverlays(page);
    await dismissObstructingModalsDynamic(page);
    await sleep(600);
    log.push(await shot(page, outDir, "02-after-modal-dismiss"));

    const afterModal = await overlayReport(page);
    await fs.writeFile(path.join(outDir, "overlay-02-after-dismiss.json"), JSON.stringify(afterModal, null, 2), "utf8");

    const fillBody = `
      var input = document.querySelector(
        'input[name="adv_pattern"], input#header_keyword, input[name="keyword"], input#keyword, input[type="search"]',
      );
      if (!input) return false;
      input.focus();
      var desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      if (desc && desc.set) desc.set.call(input, kw); else input.value = kw;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    `;
    const filled = await page.evaluate(new Function("kw", fillBody) as (kw: string) => boolean, KEYWORD);
    await humanPause(200, 400);
    log.push(await shot(page, outDir, "03-keyword-entry"));

    let submitted = false;
    if (filled) {
      submitted = await trySubmitSearchForm(page, KEYWORD);
    }
    if (!submitted) {
      await page.keyboard.press("Enter").catch(() => {});
    }
    log.push(await shot(page, outDir, "04-after-submit"));

    await page.waitForLoadState("networkidle", { timeout: 28_000 }).catch(() => {});
    await sleep(2000);
    log.push(await shot(page, outDir, "05-results-networkidle"));

    const finalUrl = page.url();
    const titlesJs = `
      var links = Array.prototype.slice.call(document.querySelectorAll('a[href*="/allas/"]'));
      var seen = {};
      var t = [];
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        var href = a.getAttribute("href") || "";
        if (!/\\/allas\\/[^?]+-\\d{4,}/i.test(href) || /\\/allasok\\//i.test(href)) continue;
        var dn = a.getAttribute("data-item-name") || "";
        var title = (dn.trim() || (a.innerText || a.title || "").trim()).slice(0, 240);
        if (title.length < 2) continue;
        var key = href.split("?")[0];
        if (seen[key]) continue;
        seen[key] = true;
        t.push(title);
        if (t.length >= 16) break;
      }
      return t;
    `;
    const titles = (await page.evaluate(new Function(titlesJs) as () => string[])) as string[];
    await fs.writeFile(
      path.join(outDir, "parsed-titles-sample.json"),
      JSON.stringify({ finalUrl, keyword: KEYWORD, titles }, null, 2),
      "utf8",
    );

    await fs.writeFile(
      path.join(outDir, "README-steps.txt"),
      [
        "Micro-step screenshots (full page):",
        ...log.map((p, i) => `  ${i + 1}. ${path.relative(repoRoot, p)}`),
        "",
        `Final URL: ${finalUrl}`,
        `Keyword: ${KEYWORD}`,
      ].join("\n"),
      "utf8",
    );

    console.log(`Profession.hu microsteps written under:\n  ${outDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
