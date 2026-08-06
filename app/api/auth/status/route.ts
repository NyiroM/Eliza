// app/api/auth/status/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  ELIZA_GATE_COOKIE,
  getGateSigningSecret,
  isGateEnabled,
} from "../../../../lib/auth/gateConfig";
import { verifyGateToken } from "../../../../lib/auth/gateToken";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

export async function GET(request: NextRequest) {
  const gateEnabled = isGateEnabled();
  if (!gateEnabled) {
    return NextResponse.json(
      { gateEnabled: false, authenticated: true, accessMode: "open" as const },
      { status: 200, headers: NO_STORE },
    );
  }

  const secret = getGateSigningSecret();
  const token = request.cookies.get(ELIZA_GATE_COOKIE)?.value;
  const authenticated = secret ? await verifyGateToken(secret, token) : false;

  return NextResponse.json(
    {
      gateEnabled: true,
      authenticated,
      accessMode: "lan_password" as const,
    },
    { status: 200, headers: NO_STORE },
  );
}
