// lib/auth/lanOrigins.ts — allow same-origin LAN hosts + loopback for CORS / Origin checks.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True for RFC1918 / link-local IPv4 used on home Wi‑Fi. */
export function isPrivateLanHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOSTS.has(h)) return true;
  if (h === "0.0.0.0") return false;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Allow browser Origin when it matches the request Host (same-origin via LAN IP)
 * or is loopback / explicitly allow-listed.
 */
export function originMatchesRequestHost(origin: string, hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  try {
    const o = new URL(origin);
    const reqHost = hostHeader.trim().toLowerCase();
    const originHost = o.host.toLowerCase();
    if (originHost === reqHost) return true;
    // Host header may omit default port; Origin always includes non-default ports.
    const hostOnly = reqHost.split(":")[0] ?? "";
    const originHostOnly = o.hostname.toLowerCase();
    if (hostOnly && originHostOnly === hostOnly && (o.port === "" || o.port === "80" || o.port === "443")) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(h);
  } catch {
    return false;
  }
}
