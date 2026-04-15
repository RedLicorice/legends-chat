import { NextResponse, type NextRequest } from "next/server";
import { refreshAccessCookie } from "@/lib/auth";
import { publicOriginServer } from "@/lib/public-origin.server";

function safeRedirectTarget(to: string | null): string {
  if (!to) return "/";
  // Only allow same-origin relative paths; reject absolute / external URLs.
  if (!to.startsWith("/") || to.startsWith("//")) return "/";
  return to;
}

export async function GET(req: NextRequest) {
  const to = safeRedirectTarget(req.nextUrl.searchParams.get("to"));
  const ok = await refreshAccessCookie();
  const origin = publicOriginServer(req);
  if (!ok) return NextResponse.redirect(new URL("/login", origin));
  return NextResponse.redirect(new URL(to, origin));
}
