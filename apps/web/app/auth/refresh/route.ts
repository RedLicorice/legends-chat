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
  // If the request host doesn't match the configured public origin (e.g. user
  // reached us via localhost while APP_PUBLIC_URL points at LAN IP), redirect
  // to the same origin the user is on so the cookies we just set still apply.
  const publicOrigin = publicOriginServer(req);
  const reqHost = req.headers.get("host");
  const publicHost = (() => { try { return new URL(publicOrigin).host; } catch { return null; } })();
  const origin = publicHost && reqHost && publicHost !== reqHost ? req.nextUrl.origin : publicOrigin;
  if (!ok) return NextResponse.redirect(new URL("/login", origin));
  return NextResponse.redirect(new URL(to, origin));
}
