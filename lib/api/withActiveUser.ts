// lib/api/withActiveUser.ts
import { NextRequest, NextResponse } from "next/server";
import { ELIZA_ACTIVE_USER_HEADER } from "../elizaActiveUserHeader";
import {
  ensureRegistryInitialized,
  getUserDir,
  runWithUserContext,
  sanitizeUserId,
  type UserContext,
} from "../storage/activeUserContext";

function headerActiveUserId(request: NextRequest): string | undefined {
  const a = request.headers.get(ELIZA_ACTIVE_USER_HEADER);
  if (a?.trim()) return a.trim();
  const b = request.headers.get(ELIZA_ACTIVE_USER_HEADER.toLowerCase());
  return b?.trim() || undefined;
}

/**
 * Runs handler with per-user storage context. Requires `X-Eliza-Active-User` (validated against registry).
 */
export async function withActiveUser(
  request: NextRequest,
  handler: (ctx: UserContext) => Promise<Response>,
): Promise<Response> {
  const raw = headerActiveUserId(request);
  if (!raw) {
    return NextResponse.json(
      { error: `Missing ${ELIZA_ACTIVE_USER_HEADER} header.` },
      { status: 400 },
    );
  }
  let id: string;
  try {
    id = sanitizeUserId(raw);
  } catch {
    return NextResponse.json({ error: "Invalid active user id." }, { status: 400 });
  }

  const reg = await ensureRegistryInitialized();
  if (!reg.users.some((u) => u.id === id)) {
    return NextResponse.json({ error: `Unknown user: ${id}` }, { status: 400 });
  }

  const root = getUserDir(id);
  const ctx: UserContext = { userId: id, root };
  return runWithUserContext(ctx, () => handler(ctx));
}
