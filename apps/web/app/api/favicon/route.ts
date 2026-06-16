import { type NextRequest, NextResponse } from "next/server";
import { getSetting } from "@legends/db/system-settings";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Browser-tab favicon resolver. The repo ships /icon-192.png and /icon-512.png
// as 412-byte placeholders (a flat purple square) so we can't point
// `<link rel="icon">` at them directly without showing that purple square in
// the tab. Instead, the layout points at this route, which:
//   - 302s to the admin's `pwa_icon_url` upload when set
//   - else falls back to /icon-512.png (placeholder; once an operator uploads
//     a real icon this becomes a no-op)
//
// Cache-Control intentionally short: when an admin uploads a new icon we
// want browsers to pick it up within a minute, not 24h.
export async function GET(req: NextRequest): Promise<NextResponse> {
  let target = "/icon-512.png";
  try {
    const v = await getSetting(db, "pwa_icon_url");
    if (typeof v === "string" && v.length > 0) target = v;
  } catch {
    // best-effort; fall through to placeholder
  }
  const url = new URL(target, req.nextUrl.origin);
  return NextResponse.redirect(url, {
    status: 302,
    headers: {
      "Cache-Control": "public, max-age=60, must-revalidate",
    },
  });
}
