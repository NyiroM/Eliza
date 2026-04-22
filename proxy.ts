import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

function applyCors(response: NextResponse, request: NextRequest): NextResponse {
  const origin = request.headers.get("origin");
  response.headers.set(
    "Access-Control-Allow-Origin",
    origin ?? "*",
  );
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
}

export function proxy(request: NextRequest) {
  if (request.method === "OPTIONS") {
    return applyCors(new NextResponse(null, { status: 204 }), request);
  }

  const response = NextResponse.next();
  return applyCors(response, request);
}

export const config = {
  matcher: "/api/:path*",
};
