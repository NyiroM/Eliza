import { NextRequest, NextResponse } from "next/server";
import {
  loadConstraintTacticsFromStorage,
  saveConstraintTacticsToStorage,
  type ConstraintTacticDomain,
  type StoredConstraintTactics,
  type VetoStance,
} from "../../../../lib/storage/constraintTactics";

const DOMAINS: ConstraintTacticDomain[] = ["location", "remote_zone", "compensation"];

function normalizeStance(v: unknown): VetoStance {
  if (v === "never_veto" || v === "soft_only" || v === "default") return v;
  return "default";
}

type PutBody = { tactics?: unknown };

export async function GET() {
  const data = await loadConstraintTacticsFromStorage();
  return NextResponse.json(data, { status: 200 });
}

export async function PUT(request: NextRequest) {
  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const raw = body.tactics && typeof body.tactics === "object" ? body.tactics : {};
  const r = raw as Record<string, unknown>;
  const tactics: Partial<Record<ConstraintTacticDomain, VetoStance>> = {};
  for (const d of DOMAINS) {
    const s = normalizeStance(r[d]);
    if (s !== "default") tactics[d] = s;
  }

  const next: StoredConstraintTactics = {
    tactics,
    updated_at: new Date().toISOString(),
  };
  await saveConstraintTacticsToStorage(next);
  return NextResponse.json(next, { status: 200 });
}
