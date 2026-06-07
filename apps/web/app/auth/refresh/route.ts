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
  // Prefer X-Forwarded-Host (client's actual host) over Host (may be rewritten
  // to the upstream address by a reverse proxy like Tailscale serve).
  const reqHost =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const publicHost = (() => { try { return new URL(publicOrigin).host; } catch { return null; } })();
  // If APP_PUBLIC_URL is set, trust it — operator configured it deliberately.
  const trustPublic = !!process.env.APP_PUBLIC_URL;
  const origin =
    !trustPublic && publicHost && reqHost && publicHost !== reqHost
      ? req.nextUrl.origin
      : publicOrigin;
  if (!ok) return NextResponse.redirect(new URL("/login", origin));
  return NextResponse.redirect(new URL(to, origin));
}
