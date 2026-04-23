import { NextRequest, NextResponse } from "next/server";
import { loadUserPreferences, saveUserPreferences } from "../../../lib/storage/userPreferences";
import {
  validatePreferredCurrencyForStorage,
  validatePreferredLocationForStorage,
} from "../../../lib/validation";

export async function GET() {
  const prefs = await loadUserPreferences();
  return NextResponse.json(prefs, { status: 200 });
}

export async function POST(request: NextRequest) {
  let body: { preferred_location?: unknown; preferred_currency?: unknown };
  try {
    body = (await request.json()) as { preferred_location?: unknown; preferred_currency?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const locCheck = validatePreferredLocationForStorage(body.preferred_location);
  if (!locCheck.ok) {
    return NextResponse.json({ error: locCheck.error }, { status: 400 });
  }
  const currencyCheck = validatePreferredCurrencyForStorage(body.preferred_currency);
  if (!currencyCheck.ok) {
    return NextResponse.json({ error: currencyCheck.error }, { status: 400 });
  }

  const current = await loadUserPreferences();
  await saveUserPreferences({
    preferred_location: locCheck.preferred_location,
    preferred_currency: currencyCheck.preferred_currency ?? current.preferred_currency,
  });
  const prefs = await loadUserPreferences();
  return NextResponse.json(prefs, { status: 200 });
}
