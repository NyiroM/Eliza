// lib/discovery/debugScreenshot.ts — optional Playwright PNG/HTML under <user>/debug/ (off by default).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { getDiscoveryDebugDir } from "./paths";

/** Set `ELIZA_DISCOVERY_DEBUG_SCREENSHOTS=1` (or `true`) to write PNG/HTML captures during discovery Playwright runs. */
function discoveryDebugCapturesEnabled(): boolean {
  const v = process.env.ELIZA_DISCOVERY_DEBUG_SCREENSHOTS?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function safeDebugSegment(label: string, maxLen = 80): string {
  return label.replace(/[^a-z0-9_-]+/gi, "_").slice(0, maxLen);
}

export async function saveDiscoveryZeroResultScreenshot(
  provider: "indeed" | "profession",
  page: Page,
  label: string,
): Promise<void> {
  if (!discoveryDebugCapturesEnabled()) return;
  try {
    await mkdir(getDiscoveryDebugDir(), { recursive: true });
    const safe = safeDebugSegment(label, 60);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(getDiscoveryDebugDir(), `${provider}-zero-${ts}-${safe}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.warn(`[discovery] Zero-result screenshot: ${file}`);
  } catch (e) {
    console.warn("[discovery] Screenshot failed:", e instanceof Error ? e.message : e);
  }
}

/** Progress / timeout / nuclear-step diagnostics (full-page PNG). */
export async function saveDiscoveryProgressScreenshot(
  provider: "indeed" | "profession",
  page: Page,
  label: string,
): Promise<string | null> {
  if (!discoveryDebugCapturesEnabled()) return null;
  try {
    await mkdir(getDiscoveryDebugDir(), { recursive: true });
    const safe = safeDebugSegment(label, 100);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(getDiscoveryDebugDir(), `${provider}-progress-${ts}-${safe}.png`);
    // Viewport-only: many progress shots per fetch; full-page PNGs dominate wall time.
    await page.screenshot({ path: file, fullPage: false });
    console.warn(`[discovery] Progress screenshot: ${file}`);
    return file;
  } catch (e) {
    console.warn("[discovery] Progress screenshot failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Raw HTML for hangs, timeouts, or parse failures. */
export async function saveDiscoveryDomSnapshot(
  provider: "indeed" | "profession",
  page: Page,
  label: string,
): Promise<string | null> {
  if (!discoveryDebugCapturesEnabled()) return null;
  try {
    await mkdir(getDiscoveryDebugDir(), { recursive: true });
    const safe = safeDebugSegment(label, 60);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(getDiscoveryDebugDir(), `${provider}-dom-${ts}-${safe}.html`);
    const html = await page.content();
    await writeFile(file, html, "utf8");
    console.warn(`[discovery] DOM snapshot: ${file}`);
    return file;
  } catch (e) {
    console.warn("[discovery] DOM snapshot failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
