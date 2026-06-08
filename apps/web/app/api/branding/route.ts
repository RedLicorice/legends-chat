import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { themes } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getSetting } from "@legends/db/system-settings";
import { parseWhitelist } from "@/lib/external-links";

export const dynamic = "force-dynamic";

// Public branding payload consumed by the static layout shell on first paint.
// Returns theme rows + community branding + external-link interstitial config.
// No auth required — the same data is rendered into the public /login screen.
export async function GET(): Promise<NextResponse> {
  const [
    themeRows,
    communityName,
    pwaIconUrl,
    accentColor,
    defaultTheme,
    sidebarCompactDefault,
    interstitialEnabledRaw,
    whitelistRaw,
  ] = await Promise.all([
    db.select().from(themes).orderBy(asc(themes.createdAt)).catch(() => []),
    getSetting(db, "community_name").catch(() => null),
    getSetting(db, "pwa_icon_url").catch(() => null),
    getSetting(db, "theme_accent_color").catch(() => null),
    getSetting(db, "default_theme").catch(() => null),
    getSetting(db, "sidebar_compact_default").catch(() => null),
    getSetting(db, "external_link_interstitial_enabled").catch(() => null),
    getSetting(db, "external_link_whitelist").catch(() => null),
  ]);

  return NextResponse.json({
    themes: themeRows.map((t) => ({
      id: t.id,
      colors: (t.colors as Record<string, string>) ?? {},
      isGlass: t.isGlass,
      bgGradient: t.bgGradient,
      customCss: t.customCss ?? null,
    })),
    branding: {
      communityName: communityName ?? null,
      pwaIconUrl: pwaIconUrl ?? null,
      accentColor: accentColor ?? null,
    },
    defaults: {
      theme: defaultTheme ?? null,
      sidebarCompact: sidebarCompactDefault ?? null,
    },
    externalLinks: {
      interstitialEnabled: interstitialEnabledRaw !== "false",
      whitelist: parseWhitelist(whitelistRaw),
      publicOrigin: process.env.APP_PUBLIC_URL ?? null,
    },
  });
}
