// app/api/auth/logout/route.ts
import { NextResponse } from "next/server";
import { ELIZA_GATE_COOKIE } from "../../../../lib/auth/gateConfig";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

export async function POST() {
  const res = NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE });
  res.cookies.set(ELIZA_GATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
