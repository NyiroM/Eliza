// lib/auth/lanAddresses.ts — advertise LAN + Tailscale URLs for remote browsers.

import os from "os";

function isUsableLanIPv4(address: string, internal: boolean): boolean {
  if (internal) return false;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return false;
  const [a, b] = address.split(".").map(Number);
  if (a === 127) return false;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** Tailscale CGNAT 100.64.0.0/10 on this host. */
function isTailscaleIPv4Address(address: string, internal: boolean): boolean {
  if (internal) return false;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function collectIPv4(predicate: (address: string, internal: boolean) => boolean): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const e of entries) {
      if (e.family !== "IPv4" && (e.family as unknown) !== 4) continue;
      if (!predicate(e.address, e.internal)) continue;
      if (!out.includes(e.address)) out.push(e.address);
    }
  }
  return out;
}

/** IPv4 addresses on this host that peers on the LAN can typically open. */
export function listLanIPv4Addresses(): string[] {
  return collectIPv4(isUsableLanIPv4);
}

/** Tailscale interface IPv4 addresses (if Tailscale is installed and up). */
export function listTailscaleIPv4Addresses(): string[] {
  return collectIPv4(isTailscaleIPv4Address);
}

export function buildLanAccessUrls(port: number): string[] {
  const p = Number.isFinite(port) && port > 0 ? port : 3000;
  return listLanIPv4Addresses().map((ip) => `http://${ip}:${p}`);
}

export function buildTailscaleAccessUrls(port: number): string[] {
  const p = Number.isFinite(port) && port > 0 ? port : 3000;
  return listTailscaleIPv4Addresses().map((ip) => `http://${ip}:${p}`);
}

export function resolveListenPort(): number {
  const fromEnv = Number(process.env.PORT ?? process.env.ELIZA_LISTEN_PORT ?? "3000");
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 3000;
}
