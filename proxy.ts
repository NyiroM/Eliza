// proxy.ts — CORS, POST internal header, LAN same-origin, optional gate password.
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ELIZA_GATE_COOKIE,
  getGateSigningSecret,
  isGateEnabled,
} from "./lib/auth/gateConfig";
import { verifyGateToken } from "./lib/auth/gateToken";
import {
  isLoopbackOrigin,
  isPrivateLanHostname,
  originMatchesRequestHost,
} from "./lib/auth/lanOrigins";

const ALLOWED_ORIGINS = new Set(
  [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    process.env.ELIZA_EXTENSION_ID ? `chrome-extension://${process.env.ELIZA_EXTENSION_ID}` : "",
    process.env.ELIZA_EXTENSION_ORIGIN ?? "",
  ].filter(Boolean),
);

function isPublicPath(pathname: string): boolean {
  if (pathname === "/login") return true;
  if (pathname.startsWith("/api/auth/login")) return true;
  if (pathname.startsWith("/api/auth/status")) return true;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico") return true;
  return false;
}

function isAuthApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/auth/");
}

function getAllowedOrigin(request: NextRequest): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (isLoopbackOrigin(origin)) return origin;
  if (originMatchesRequestHost(origin, request.headers.get("host"))) {
    try {
      const host = new URL(origin).hostname;
      if (isPrivateLanHostname(host) || isLoopbackOrigin(origin)) return origin;
    } catch {
      return null;
    }
  }
  return null;
}

function applyCors(response: NextResponse, request: NextRequest): NextResponse {
  const allowedOrigin = getAllowedOrigin(request);
  if (allowedOrigin) {
    response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
  }
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Eliza-Internal, X-Eliza-Active-User",
  );
  response.headers.set("Vary", "Origin");
  return response;
}

function redirectToLogin(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (next && next !== "/login") {
    url.searchParams.set("next", next);
  }
  return NextResponse.redirect(url);
}

async function gateAllows(request: NextRequest): Promise<boolean> {
  if (!isGateEnabled()) return true;
  if (isPublicPath(request.nextUrl.pathname)) return true;
  const secret = getGateSigningSecret();
  if (!secret) return false;
  const token = request.cookies.get(ELIZA_GATE_COOKIE)?.value;
  return verifyGateToken(secret, token);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApiPath = pathname.startsWith("/api/");
  const isPostApi = request.method === "POST" && isApiPath;

  // Gate before CORS rejection so unauthenticated browsers get login / 401 cleanly.
  if (!(await gateAllows(request))) {
    if (isApiPath) {
      return applyCors(
        NextResponse.json({ error: "Unauthorized — sign in at /login" }, { status: 401 }),
        request,
      );
    }
    return redirectToLogin(request);
  }

  if (isPostApi && !isAuthApiPath(pathname) && request.headers.get("X-Eliza-Internal") !== "true") {
    return applyCors(NextResponse.json({ error: "Forbidden" }, { status: 403 }), request);
  }

  if (request.method === "OPTIONS") {
    if (request.headers.get("origin") && !getAllowedOrigin(request)) {
      return NextResponse.json({ error: "Forbidden origin" }, { status: 403 });
    }
    return applyCors(new NextResponse(null, { status: 204 }), request);
  }

  // Origin check: API only (page navigations may send Origin on some browsers).
  if (isApiPath && request.headers.get("origin") && !getAllowedOrigin(request)) {
    return NextResponse.json({ error: "Forbidden origin" }, { status: 403 });
  }

  const response = NextResponse.next();
  return applyCors(response, request);
}

export const config = {
  matcher: [
    /*
     * Gate + CORS for app + API. Skip static assets Next serves under /_next/static.
     * /_next/webpack etc. still go through isPublicPath.
     */
    "/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp)$).*)",
  ],
};
