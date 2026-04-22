import { NextRequest, NextResponse } from "next/server";
import { loadUserPreferences, saveUserPreferences } from "../../../lib/storage/userPreferences";

export async function GET() {
  const prefs = await loadUserPreferences();
  return NextResponse.json(prefs, { status: 200 });
}

export async function POST(request: NextRequest) {
  let body: { preferred_location?: unknown };
  try {
    body = (await request.json()) as { preferred_location?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const preferred_location =
    typeof body.preferred_location === "string" ? body.preferred_location : null;

  await saveUserPreferences({ preferred_location });
  const prefs = await loadUserPreferences();
  return NextResponse.json(prefs, { status: 200 });
}
