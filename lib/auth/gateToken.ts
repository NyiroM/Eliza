// lib/auth/gateToken.ts — HMAC session token for ELIZA_GATE_PASSWORD (Edge + Node safe).

const TOKEN_PREFIX = "v1";

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(sig);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Build cookie payload: v1.<expMs>.<hmac> */
export async function mintGateToken(secret: string, maxAgeSec: number): Promise<string> {
  const expMs = Date.now() + maxAgeSec * 1000;
  const payload = `${TOKEN_PREFIX}|${expMs}`;
  const mac = await hmacSha256Hex(secret, payload);
  return `${TOKEN_PREFIX}.${expMs}.${mac}`;
}

export async function verifyGateToken(secret: string, token: string | undefined | null): Promise<boolean> {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [prefix, expRaw, mac] = parts;
  if (prefix !== TOKEN_PREFIX) return false;
  const expMs = Number(expRaw);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  if (!/^[0-9a-f]{64}$/i.test(mac)) return false;
  const expected = await hmacSha256Hex(secret, `${TOKEN_PREFIX}|${expMs}`);
  return timingSafeEqualHex(mac.toLowerCase(), expected.toLowerCase());
}

export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
