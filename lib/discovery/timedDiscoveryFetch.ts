// lib/discovery/timedDiscoveryFetch.ts — bounded HTTP for discovery sources (Indeed RSS, Profession list, etc.).
import { DISCOVERY_HTTP_FETCH_TIMEOUT_MS } from "../../config/constants";

function isAbortError(err: unknown): boolean {
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") {
    return true;
  }
  return err instanceof Error && err.name === "AbortError";
}

/** Same-origin / external listing fetch with AbortSignal (stalled TCP / slow CDN). */
export async function timedDiscoveryFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const ms = DISCOVERY_HTTP_FETCH_TIMEOUT_MS;
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (isAbortError(e)) {
      throw new Error(`Discovery HTTP fetch timed out after ${ms}ms: ${url.slice(0, 120)}`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function readDiscoveryResponseText(res: Response): Promise<string> {
  const ms = DISCOVERY_HTTP_FETCH_TIMEOUT_MS;
  return await new Promise<string>((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error(`Discovery HTTP body read timed out after ${ms}ms`)), ms);
    void res.text().then(
      (t) => {
        clearTimeout(tid);
        resolve(t);
      },
      (e) => {
        clearTimeout(tid);
        reject(e);
      },
    );
  });
}
