// app/api/users/route.ts — list registry users and create new profiles (no active-user header).
import { NextRequest, NextResponse } from "next/server";
import { createUserFromDisplayName, readRegistry } from "../../../lib/storage/activeUserContext";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

export async function GET() {
  const registry = await readRegistry();
  return NextResponse.json(registry, { status: 200, headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  let body: { displayName?: unknown };
  try {
    body = (await request.json()) as { displayName?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
  }
  const name = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "displayName is required." }, { status: 400, headers: NO_STORE });
  }
  try {
    const { id, user } = await createUserFromDisplayName(name);
    return NextResponse.json({ id, user }, { status: 201, headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not create user.";
    return NextResponse.json({ error: msg }, { status: 400, headers: NO_STORE });
  }
}
