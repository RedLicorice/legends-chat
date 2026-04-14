import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE } from "@legends/shared";

const PUBLIC_PATHS = ["/auth/callback", "/api/health", "/manifest.webmanifest", "/sw.js"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p)) || pathname.startsWith("/_next") || pathname.startsWith("/emoji")) {
    return NextResponse.next();
  }
  const token = req.cookies.get(ACCESS_COOKIE)?.value;
  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
