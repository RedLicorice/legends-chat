import { NextResponse, type NextRequest } from "next/server";
import { refreshAccessCookie } from "@/lib/auth";

function safeRedirectTarget(to: string | null): string {
  if (!to) return "/";
  // Only allow same-origin relative paths; reject absolute / external URLs.
  if (!to.startsWith("/") || to.startsWith("//")) return "/";
  return to;
}

export async function GET(req: NextRequest) {
  const to = safeRedirectTarget(req.nextUrl.searchParams.get("to"));
  const ok = await refreshAccessCookie();
  if (!ok) {
    const url = new URL("/login", req.url);
    return NextResponse.redirect(url);
  }
  return NextResponse.redirect(new URL(to, req.url));
}
