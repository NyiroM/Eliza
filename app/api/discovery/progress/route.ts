import { NextResponse } from "next/server";
import { readDiscoveryProgress } from "../../../../lib/discovery/progress";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

export async function GET() {
  const progress = await readDiscoveryProgress();
  return NextResponse.json(progress, { headers: NO_STORE });
}
