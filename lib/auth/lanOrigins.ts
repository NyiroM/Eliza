// lib/auth/lanOrigins.ts — allow same-origin LAN / Tailscale hosts + loopback for CORS.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function parseIPv4(hostname: string): [number, number, number, number] | null {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [
    number,
    number,
    number,
    number,
  ];
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

/** Tailscale CGNAT: 100.64.0.0/10 (100.64.0.0 – 100.127.255.255). */
export function isTailscaleIPv4(hostname: string): boolean {
  const parts = parseIPv4(hostname);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 100 && b >= 64 && b <= 127;
}

/** MagicDNS / Tailscale Serve hostnames (*.ts.net). */
export function isTailscaleHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, "");
  return h === "ts.net" || h.endsWith(".ts.net");
}

/** True for RFC1918 / link-local IPv4 used on home Wi‑Fi (not Tailscale CGNAT). */
export function isPrivateLanHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOSTS.has(h)) return true;
  if (h === "0.0.0.0") return false;

  const parts = parseIPv4(h);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Hostnames we treat as trusted same-origin peers: loopback, home LAN, Tailscale.
 * Used when Origin matches the request Host header.
 */
export function isTrustedMeshHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOSTS.has(h)) return true;
  if (isPrivateLanHostname(h)) return true;
  if (isTailscaleIPv4(h)) return true;
  if (isTailscaleHostname(h)) return true;
  return false;
}

/**
 * Allow browser Origin when it matches the request Host (same-origin via LAN / Tailscale)
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
