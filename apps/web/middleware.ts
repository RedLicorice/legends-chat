import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@legends/shared";
import { publicOrigin } from "@/lib/public-origin";

const PUBLIC_PATHS = [
  "/login",
  "/register",
  "/auth/callback",
  "/auth/browser-open",
  "/auth/landing",
  "/auth/refresh",
  "/api/health",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/refresh",
  "/api/auth/passkey/authenticate",
  "/api/auth/landing-info",
  "/api/auth/telegram-register",
  "/api/auth/telegram-login",
  "/api/register-config",
  "/api/invite-check",
  "/api/user/email-link/verify",
  "/manifest.webmanifest",
  "/sw.js",
  "/docs/whitepaper",
];

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/emoji") ||
    pathname.startsWith("/socket.io")
  ) {
    return NextResponse.next();
  }

  if (req.cookies.get(ACCESS_COOKIE)?.value) return NextResponse.next();

  // API routes must not get HTML redirects — return 401 so the client can
  // handle it (e.g. show a session-expired toast and redirect itself).
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // No access cookie. If we still have a refresh cookie, return an HTML shell
  // that refreshes the token client-side. This avoids the 302→/auth/refresh→302
  // redirect chain that causes a white blank screen on PWA cold open.
  // RSC requests (Next.js client router navigations) must NOT receive HTML —
  // the RSC parser will choke and throw React error #310. Redirect those to
  // /login so the full-page navigation restores a coherent HTML context.
  if (req.cookies.get(REFRESH_COOKIE)?.value) {
    const isRsc =
      req.headers.get("RSC") === "1" ||
      req.headers.has("Next-Router-State-Tree") ||
      req.headers.has("Next-Router-Prefetch");
    if (isRsc) {
      return NextResponse.redirect(new URL("/login", publicOrigin(req)));
    }
    const to = encodeURIComponent(pathname + search);
    return new NextResponse(
      `<!DOCTYPE html><html style="background:#0b0d12"><head><meta charset="utf-8"></head><body style="background:#0b0d12;margin:0"><script>(function(){fetch('/api/auth/refresh',{method:'POST',credentials:'include'}).then(function(r){location.replace(r.ok?decodeURIComponent('${to}'):'/login');}).catch(function(){location.replace('/login');});})();</script></body></html>`,
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  return NextResponse.redirect(new URL("/login", publicOrigin(req)));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|uploads/avatars/|uploads/gifs/).*)"],
};
