// lib/discovery/playwrightChromiumPreflight.ts
import { existsSync } from "node:fs";

/**
 * When ELIZA_DISCOVERY_PLAYWRIGHT=1, log a clear install hint if Chromium binaries are missing.
 * Does not throw (Profession sync may still fall back to HTTP).
 */
export async function warnIfPlaywrightChromiumMissingForDiscovery(): Promise<void> {
  if (process.env.ELIZA_DISCOVERY_PLAYWRIGHT !== "1") return;
  try {
    const { chromium } = await import("playwright");
    const exe = chromium.executablePath();
    if (exe && !existsSync(exe)) {
      console.error(
        "[discovery] ELIZA_DISCOVERY_PLAYWRIGHT=1 but Playwright Chromium is not installed.\n" +
          "  Run: npx playwright install chromium\n" +
          "  Or set ELIZA_DISCOVERY_PLAYWRIGHT=0 to use HTTP-only Profession.hu fetching.",
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[discovery] Playwright Chromium preflight skipped:", msg);
  }
}
