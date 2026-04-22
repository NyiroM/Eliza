import { NextRequest, NextResponse } from "next/server";
import {
  addUserConstraint,
  loadUserConstraintsFromStorage,
  removeUserConstraint,
} from "../../../lib/storage/userConstraints";

type ConstraintRequestBody = {
  constraint?: unknown;
};

export async function GET() {
  const data = await loadUserConstraintsFromStorage();
  return NextResponse.json(data, { status: 200 });
}

export async function POST(request: NextRequest) {
  let body: ConstraintRequestBody;
  try {
    body = (await request.json()) as ConstraintRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.constraint !== "string" || !body.constraint.trim()) {
    return NextResponse.json(
      { error: 'Body must include non-empty string field: "constraint".' },
      { status: 400 },
    );
  }

  const saved = await addUserConstraint(body.constraint);
  return NextResponse.json(saved, { status: 200 });
}

export async function DELETE(request: NextRequest) {
  let body: ConstraintRequestBody;
  try {
    body = (await request.json()) as ConstraintRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.constraint !== "string" || !body.constraint.trim()) {
    return NextResponse.json(
      { error: 'Body must include non-empty string field: "constraint".' },
      { status: 400 },
    );
  }

  const updated = await removeUserConstraint(body.constraint);
  return NextResponse.json(updated, { status: 200 });
}
