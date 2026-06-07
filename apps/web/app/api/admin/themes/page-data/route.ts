import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { PERMISSIONS } from "@legends/shared";
import { themes } from "@legends/db/schema";
import { getSetting } from "@legends/db/system-settings";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireAdmin(PERMISSIONS.ADMIN_CONFIG);
  if (gate instanceof NextResponse) return gate;

  const [themeRows, defaultTheme] = await Promise.all([
    db.select().from(themes).orderBy(asc(themes.createdAt)),
    getSetting(db, "default_theme"),
  ]);

  return NextResponse.json({
    themes: themeRows.map((t) => ({
      id: t.id,
      name: t.name,
      isBuiltin: t.isBuiltin,
      colors: (t.colors as Record<string, string>) ?? {},
      isGlass: t.isGlass,
      bgGradient: t.bgGradient ?? "",
      customCss: t.customCss ?? null,
    })),
    defaultTheme: defaultTheme ?? "dark",
  });
}
