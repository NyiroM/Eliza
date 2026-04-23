import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  // Optional hardcoded extension origin from env, e.g. chrome-extension://abcdefghijklmnop...
  process.env.ELIZA_EXTENSION_ID ? `chrome-extension://${process.env.ELIZA_EXTENSION_ID}` : "",
  process.env.ELIZA_EXTENSION_ORIGIN ?? "",
].filter(Boolean));

function getAllowedOrigin(request: NextRequest): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

function applyCors(response: NextResponse, request: NextRequest): NextResponse {
  const allowedOrigin = getAllowedOrigin(request);
  if (allowedOrigin) {
    response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
  }
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Eliza-Internal");
  response.headers.set("Vary", "Origin");
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApiPath = pathname.startsWith("/api/");
  const isPostApi = request.method === "POST" && isApiPath;

  if (isPostApi && request.headers.get("X-Eliza-Internal") !== "true") {
    return applyCors(NextResponse.json({ error: "Forbidden" }, { status: 403 }), request);
  }

  if (request.method === "OPTIONS") {
    if (request.headers.get("origin") && !getAllowedOrigin(request)) {
      return NextResponse.json({ error: "Forbidden origin" }, { status: 403 });
    }
    return applyCors(new NextResponse(null, { status: 204 }), request);
  }

  if (request.headers.get("origin") && !getAllowedOrigin(request)) {
    return NextResponse.json({ error: "Forbidden origin" }, { status: 403 });
  }

  const response = NextResponse.next();
  return applyCors(response, request);
}

export const config = {
  matcher: "/api/:path*",
};
