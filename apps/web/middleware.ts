import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@legends/shared";
import { publicOrigin } from "@/lib/public-origin";

const PUBLIC_PATHS = [
  "/login",
  "/auth/callback",
  "/auth/refresh",
  "/api/health",
  "/manifest.webmanifest",
  "/sw.js",
];

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/emoji")
  ) {
    return NextResponse.next();
  }

  if (req.cookies.get(ACCESS_COOKIE)?.value) return NextResponse.next();

  // API routes must not get HTML redirects — return 401 so the client can
  // handle it (e.g. show a session-expired toast and redirect itself).
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const origin = publicOrigin(req);

  // No access cookie. If we still have a refresh cookie, try to silently
  // renew before falling back to the login page.
  if (req.cookies.get(REFRESH_COOKIE)?.value) {
    return NextResponse.redirect(
      new URL(`/auth/refresh?to=${encodeURIComponent(pathname + search)}`, origin),
    );
  }

  return NextResponse.redirect(new URL("/login", origin));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
