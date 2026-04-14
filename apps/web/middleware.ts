import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@legends/shared";

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

  // No access cookie. If we still have a refresh cookie, try to silently
  // renew before falling back to the login page.
  if (req.cookies.get(REFRESH_COOKIE)?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/auth/refresh";
    url.search = `?to=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
