import { NextResponse } from "next/server";
import { loadDiscoverySettings } from "../../../../lib/discovery/settings";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

export async function GET() {
  const settings = await loadDiscoverySettings();
  return NextResponse.json(settings, { headers: NO_STORE });
}
