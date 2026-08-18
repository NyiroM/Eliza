// app/api/server-info/route.ts — LAN + Tailscale URLs + access mode for the dashboard banner.
import { NextRequest, NextResponse } from "next/server";
import {
  ELIZA_GATE_COOKIE,
  getGateSigningSecret,
  isGateEnabled,
} from "../../../lib/auth/gateConfig";
import { verifyGateToken } from "../../../lib/auth/gateToken";
import {
  buildLanAccessUrls,
  buildTailscaleAccessUrls,
  resolveListenPort,
} from "../../../lib/auth/lanAddresses";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

export async function GET(request: NextRequest) {
  const gateEnabled = isGateEnabled();
  if (gateEnabled) {
    const secret = getGateSigningSecret();
    const token = request.cookies.get(ELIZA_GATE_COOKIE)?.value;
    const ok = secret ? await verifyGateToken(secret, token) : false;
    if (!ok) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
    }
  }

  const port = resolveListenPort();
  const lanUrls = buildLanAccessUrls(port);
  const tailscaleUrls = buildTailscaleAccessUrls(port);
  const hostHeader = request.headers.get("host")?.trim() || `localhost:${port}`;
  const hasTailscale = tailscaleUrls.length > 0;

  return NextResponse.json(
    {
      accessMode: hasTailscale ? ("tailscale" as const) : ("lan" as const),
      accessModeLabel: hasTailscale
        ? "LAN + Tailscale remote (step 1 + 2)"
        : "Same Wi‑Fi / LAN (step 1) · Tailscale optional for remote",
      gateEnabled,
      listenHost: "0.0.0.0",
      port,
      requestHost: hostHeader,
      localhostUrl: `http://localhost:${port}`,
      lanUrls,
      tailscaleUrls,
      remoteHint:
        "Install Tailscale on this phone/laptop (same account as the host). No router port forward.",
      wanNote: hasTailscale
        ? "Tailscale mesh is up — use a Tailscale URL away from home. Do not port-forward 3000 on your router."
        : "For access away from home: install Tailscale on this host and your phone (see README). Do not open the ELIZA port on the public internet.",
    },
    { status: 200, headers: NO_STORE },
  );
}
