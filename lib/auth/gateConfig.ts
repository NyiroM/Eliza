// lib/auth/gateConfig.ts — shared gate password / cookie names for LAN UI access (step 1).

/** HttpOnly cookie set after successful gate login. */
export const ELIZA_GATE_COOKIE = "eliza_gate";

/** Cookie max-age (7 days). LAN sessions are long-lived for phone/laptop convenience. */
export const ELIZA_GATE_MAX_AGE_SEC = 60 * 60 * 24 * 7;

/**
 * When set, the dashboard and APIs require a valid gate cookie (see proxy.ts).
 * Leave unset for classic localhost-only use without a login screen.
 */
export function getGatePassword(): string | null {
  const raw = process.env.ELIZA_GATE_PASSWORD;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isGateEnabled(): boolean {
  return getGatePassword() !== null;
}

/** Optional separate HMAC secret; defaults to the gate password. */
export function getGateSigningSecret(): string | null {
  const explicit = process.env.ELIZA_GATE_SECRET?.trim();
  if (explicit) return explicit;
  return getGatePassword();
}
