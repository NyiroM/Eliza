// app/api/auth/login/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  ELIZA_GATE_COOKIE,
  ELIZA_GATE_MAX_AGE_SEC,
  getGatePassword,
  getGateSigningSecret,
  isGateEnabled,
} from "../../../../lib/auth/gateConfig";
import { mintGateToken, timingSafeEqualString } from "../../../../lib/auth/gateToken";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

type Body = { password?: unknown };

export async function POST(request: NextRequest) {
  if (!isGateEnabled()) {
    return NextResponse.json(
      { ok: true, gateEnabled: false, message: "Gate password is not configured; login is not required." },
      { status: 200, headers: NO_STORE },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
  }

  const password = typeof body.password === "string" ? body.password : "";
  const expected = getGatePassword();
  const secret = getGateSigningSecret();
  if (!expected || !secret) {
    return NextResponse.json({ error: "Gate not configured." }, { status: 500, headers: NO_STORE });
  }

  if (!timingSafeEqualString(password, expected)) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401, headers: NO_STORE });
  }

  const token = await mintGateToken(secret, ELIZA_GATE_MAX_AGE_SEC);
  const res = NextResponse.json({ ok: true, gateEnabled: true }, { status: 200, headers: NO_STORE });
  res.cookies.set(ELIZA_GATE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: ELIZA_GATE_MAX_AGE_SEC,
    secure: request.nextUrl.protocol === "https:",
  });
  return res;
}
