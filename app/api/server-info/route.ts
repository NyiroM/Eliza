// app/api/server-info/route.ts — LAN URLs + access mode for the dashboard banner.
import { NextRequest, NextResponse } from "next/server";
import {
  ELIZA_GATE_COOKIE,
  getGateSigningSecret,
  isGateEnabled,
} from "../../../lib/auth/gateConfig";
import { verifyGateToken } from "../../../lib/auth/gateToken";
import { buildLanAccessUrls, resolveListenPort } from "../../../lib/auth/lanAddresses";

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
  const hostHeader = request.headers.get("host")?.trim() || `localhost:${port}`;

  return NextResponse.json(
    {
      accessMode: "lan" as const,
      accessModeLabel: "Same Wi‑Fi / LAN only (step 1)",
      gateEnabled,
      listenHost: "0.0.0.0",
      port,
      requestHost: hostHeader,
      localhostUrl: `http://localhost:${port}`,
      lanUrls,
      wanNote:
        "Internet-wide access (step 2) is not enabled yet — keep the host on your private network.",
    },
    { status: 200, headers: NO_STORE },
  );
}
