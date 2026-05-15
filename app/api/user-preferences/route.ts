import { NextRequest, NextResponse } from "next/server";
import { withActiveUser } from "../../../lib/api/withActiveUser";
import { loadUserPreferences, saveUserPreferences } from "../../../lib/storage/userPreferences";
import {
  validateOllamaModelForStorage,
  validatePreferredCurrencyForStorage,
  validatePreferredLocationForStorage,
} from "../../../lib/validation";

export async function GET(request: NextRequest) {
  return withActiveUser(request, async () => {
  const prefs = await loadUserPreferences();
  return NextResponse.json(prefs, { status: 200 });
  });
}

export async function POST(request: NextRequest) {
  return withActiveUser(request, async () => {
  let body: {
    preferred_location?: unknown;
    preferred_currency?: unknown;
    ollama_model?: unknown;
  };
  try {
    body = (await request.json()) as {
      preferred_location?: unknown;
      preferred_currency?: unknown;
      ollama_model?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const current = await loadUserPreferences();

  let preferred_location = current.preferred_location;
  if (body.preferred_location !== undefined) {
    const locCheck = validatePreferredLocationForStorage(body.preferred_location);
    if (!locCheck.ok) {
      return NextResponse.json({ error: locCheck.error }, { status: 400 });
    }
    preferred_location = locCheck.preferred_location;
  }

  let preferred_currency = current.preferred_currency;
  if (body.preferred_currency !== undefined) {
    const currencyCheck = validatePreferredCurrencyForStorage(body.preferred_currency);
    if (!currencyCheck.ok) {
      return NextResponse.json({ error: currencyCheck.error }, { status: 400 });
    }
    preferred_currency = currencyCheck.preferred_currency ?? current.preferred_currency;
  }

  let ollama_model = current.ollama_model;
  if (body.ollama_model !== undefined) {
    const omCheck = validateOllamaModelForStorage(body.ollama_model);
    if (!omCheck.ok) {
      return NextResponse.json({ error: omCheck.error }, { status: 400 });
    }
    ollama_model = omCheck.ollama_model;
  }

  await saveUserPreferences({
    preferred_location,
    preferred_currency,
    ollama_model,
  });
  const prefs = await loadUserPreferences();
  return NextResponse.json(prefs, { status: 200 });
  });
}
