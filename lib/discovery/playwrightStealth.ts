// lib/discovery/playwrightStealth.ts — light anti-automation mitigations for discovery scrapers.
import type { Page } from "playwright";

export function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export async function humanPause(minMs = 400, maxMs = 1400): Promise<void> {
  await new Promise((r) => setTimeout(r, randomBetween(minMs, maxMs)));
}

export async function wiggleMouse(page: Page): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  for (let i = 0; i < 3; i += 1) {
    const x = randomBetween(80, Math.max(90, vp.width - 80));
    const y = randomBetween(60, Math.max(70, vp.height - 60));
    await page.mouse.move(x, y, { steps: randomBetween(8, 18) });
    await humanPause(120, 350);
  }
}

/** Common Chromium flags to reduce trivial automation signals (use with care). */
export const STEALTH_CHROMIUM_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
  "--no-default-browser-check",
];

export async function initNavigatorWebdriverPatch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
        configurable: true,
      });
    } catch {
      /* ignore */
    }
  });
}
