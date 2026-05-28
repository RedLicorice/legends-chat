import { type NextRequest, NextResponse } from "next/server";
import { clearAuthCookies } from "@/lib/auth";
import { publicOriginServer } from "@/lib/public-origin.server";

export async function POST(req: NextRequest) {
  await clearAuthCookies();
  // Stay on the request's actual host so the just-cleared cookies still apply
  // (avoids bouncing localhost users to APP_PUBLIC_URL's LAN IP).
  const publicOrigin = publicOriginServer(req);
  const reqHost = req.headers.get("host");
  const publicHost = (() => { try { return new URL(publicOrigin).host; } catch { return null; } })();
  const origin = publicHost && reqHost && publicHost !== reqHost ? req.nextUrl.origin : publicOrigin;
  return NextResponse.redirect(new URL("/login", origin), 303);
}
