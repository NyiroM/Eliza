import { NextRequest, NextResponse } from "next/server";
import { appendUserCorrection } from "../../../lib/storage/userCorrections";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
} as const;

function jsonNoStore(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

type Body = {
  correction?: unknown;
};

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return jsonNoStore({ error: "Invalid JSON body." }, 400);
  }

  if (typeof body.correction !== "string" || !body.correction.trim()) {
    return jsonNoStore(
      { error: 'Body must include non-empty string field "correction".' },
      400,
    );
  }

  const data = await appendUserCorrection(body.correction);
  return jsonNoStore(
    {
      ok: true,
      count: data.corrections.length,
      updated_at: data.updated_at,
    },
    200,
  );
}
