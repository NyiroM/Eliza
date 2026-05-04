// lib/discovery/sources/professionHuNuclear.ts — non-destructive overlay handling (avoid removing search <form> / app shell).
import type { Page } from "playwright";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Escape + unlock scroll + remove only obvious dialog/cookie layers (never generic <form>).
 * Previous "nuclear" pass removed high‑z fixed nodes and could delete the search form / React root.
 */
export async function nuclearProfessionHuModalClearance(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await sleep(200);
  await page.keyboard.press("Escape");
  await sleep(250);

  // String-built function body: tsx/esbuild can inject `__name()` into parsed `page.evaluate`
  // callbacks; that helper does not exist in the browser runtime.
  const stripBody = `
    document.body.style.overflow = "auto";
    document.documentElement.style.overflow = "auto";
    function remove(el) {
      try { el.remove(); } catch (e0) {
        try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e1) {}
      }
    }
    function shouldStrip(h) {
      if (h.tagName === "MAIN" || h.closest("main")) return false;
      if (h.tagName === "FORM") return false;
      if (h.tagName === "DIALOG") return true;
      var id = (h.id || "").toLowerCase();
      var cls = (typeof h.className === "string" ? h.className : "").toLowerCase();
      var role = (h.getAttribute("role") || "").toLowerCase();
      var blob = id + " " + cls + " " + role;
      if (role === "dialog" || role === "alertdialog") return true;
      if (h.getAttribute("aria-modal") === "true") return true;
      if (/cookie|consent|onetrust|cookiebot|gdpr|privacy-banner/i.test(blob)) return true;
      if (/modal-backdrop|backdrop|overlay-underlay|blocking/i.test(blob)) return true;
      var st = window.getComputedStyle(h);
      var z = parseInt(st.zIndex, 10);
      if (isFinite(z) && z >= 50000 && (st.position === "fixed" || st.position === "sticky")) {
        if (/modal|dialog|drawer|sheet|popup/i.test(blob)) return true;
      }
      return false;
    }
    var d1 = document.querySelectorAll("dialog, [role='dialog'], [aria-modal='true']");
    for (var i = 0; i < d1.length; i++) {
      var el = d1[i];
      if (shouldStrip(el)) remove(el);
    }
    var d2 = document.querySelectorAll("div, section, aside");
    for (var j = 0; j < d2.length; j++) {
      var h = d2[j];
      if (shouldStrip(h)) remove(h);
    }
  `;
  await page.evaluate(new Function(stripBody) as () => void);

  // Second pass: large fixed/sticky layers that look like cookie / CMP walls (often z ~ 1e4–1e5).
  const cookieHostile = `
    function remove(el) {
      try { el.remove(); } catch (e0) {
        try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e1) {}
      }
    }
    function stripCookieHostile(h) {
      if (h.tagName === "MAIN" || h.closest("main")) return false;
      if (h.tagName === "FORM") return false;
      var id = (h.id || "").toLowerCase();
      var cls = (typeof h.className === "string" ? h.className : "").toLowerCase();
      var blob = id + " " + cls;
      if (!/cookie|consent|onetrust|cookiebot|gdpr|süti|suti|cmp|privacy|banner/i.test(blob)) return false;
      var st = window.getComputedStyle(h);
      if (st.position !== "fixed" && st.position !== "sticky") return false;
      var z = parseInt(st.zIndex, 10);
      if (!isFinite(z) || z < 500) return false;
      var r = h.getBoundingClientRect();
      var area = r.width * r.height;
      var vp = window.innerWidth * window.innerHeight;
      if (area < vp * 0.22) return false;
      return true;
    }
    var nodes = document.querySelectorAll("div, section, aside, dialog");
    for (var i = 0; i < nodes.length; i++) {
      if (stripCookieHostile(nodes[i])) remove(nodes[i]);
    }
  `;
  await page.evaluate(new Function(cookieHostile) as () => void);
}
