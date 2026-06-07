import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { getSetting } from "@legends/db/system-settings";
import { db } from "@/lib/db";

// Bootstrap payload for the /settings page. The previous SSR page read the
// theme + sidebar-compact cookies and looked up their system-default fallbacks.
// We resolve those server-side here so the client only needs one round trip.
// Auth identity (id/role/permissions/etc.) is already covered by /api/me —
// SettingsClient consumes that via useMe() and composes with this payload.
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const jar = await cookies();
  const userTheme = jar.get("lc_theme")?.value;
  const userSidebarCompact = jar.get("lc_sidebar_compact")?.value;

  const [defaultTheme, sidebarCompactDefault] = await Promise.all([
    getSetting(db, "default_theme").catch(() => null),
    getSetting(db, "sidebar_compact_default").catch(() => null),
  ]);

  const currentTheme = userTheme ?? defaultTheme ?? "dark";
  const currentCompact = userSidebarCompact ?? sidebarCompactDefault ?? "minimal";

  return NextResponse.json({
    currentTheme,
    currentCompact,
  });
}
