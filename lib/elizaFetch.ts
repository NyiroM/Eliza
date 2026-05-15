// lib/elizaFetch.ts — attach active profile id to same-origin API calls (see withActiveUser on server).
import { ELIZA_ACTIVE_USER_HEADER } from "./elizaActiveUserHeader";

export { ELIZA_ACTIVE_USER_HEADER };
export const ELIZA_ACTIVE_USER_LS_KEY = "eliza_active_user_id";

export function getPersistedActiveUserId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = localStorage.getItem(ELIZA_ACTIVE_USER_LS_KEY)?.trim();
    return v || null;
  } catch {
    return null;
  }
}

export function persistActiveUserId(userId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(ELIZA_ACTIVE_USER_LS_KEY, userId);
  } catch {
    /* ignore */
  }
}

export function elizaFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? undefined);
  const id = getPersistedActiveUserId();
  if (id) headers.set(ELIZA_ACTIVE_USER_HEADER, id);
  return fetch(input, { ...init, headers });
}
