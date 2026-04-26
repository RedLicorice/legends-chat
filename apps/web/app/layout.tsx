import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { getSetting } from "@legends/db/system-settings";
import { db } from "@/lib/db";
import { themes } from "@legends/db/schema";
import { asc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const [name, iconUrl] = await Promise.all([
    getSetting(db, "community_name").catch(() => null),
    getSetting(db, "pwa_icon_url").catch(() => null),
  ]);

  const icon = iconUrl ?? "/icon-192.png";

  return {
    title: name ?? "Legends Chat",
    description: "Community chat",
    icons: {
      icon: [{ url: icon }],
      apple: [{ url: icon }],
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#0b0d12",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

function buildThemeCss(
  themeRows: { id: string; colors: Record<string, string>; isGlass: boolean; bgGradient: string | null }[],
): string {
  return themeRows.map((t) => {
    const colors = t.colors ?? {};
    const vars = Object.entries(colors)
      .map(([k, v]) => `--ch-${k}:${v}`)
      .join(";");

    let css = `[data-theme="${t.id}"]{${vars}}`;

    if (t.isGlass) {
      const grad =
        t.bgGradient ??
        "radial-gradient(ellipse 90% 90% at 15% 10%, #1c1448 0%, #0b0e22 55%, #070c14 100%)";
      css += `[data-theme="${t.id}"] body{background:${grad};background-attachment:fixed}`;
    }

    return css;
  }).join("");
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const userTheme = jar.get("lc_theme")?.value;
  const userSidebarCompact = jar.get("lc_sidebar_compact")?.value;

  const [allThemes, defaultTheme, sidebarCompactDefault] = await Promise.all([
    db.select().from(themes).orderBy(asc(themes.createdAt)).catch(() => []),
    getSetting(db, "default_theme").catch(() => null),
    getSetting(db, "sidebar_compact_default").catch(() => null),
  ]);

  const resolvedSidebarCompact = userSidebarCompact ?? sidebarCompactDefault ?? "minimal";

  const validIds = new Set(allThemes.map((t) => t.id));
  const resolved = validIds.has(userTheme ?? "") ? userTheme! : (validIds.has(defaultTheme ?? "") ? defaultTheme! : "dark");
  const activeTheme = allThemes.find((t) => t.id === resolved);
  const isGlass = activeTheme?.isGlass ?? false;

  const themeCss = buildThemeCss(
    allThemes.map((t) => ({
      id: t.id,
      colors: (t.colors as Record<string, string>) ?? {},
      isGlass: t.isGlass,
      bgGradient: t.bgGradient,
    })),
  );

  return (
    <html lang="en" data-theme={resolved} data-glass={isGlass ? "1" : "0"} data-sidebar-compact={resolvedSidebarCompact} suppressHydrationWarning>
      <head>
        {themeCss && <style dangerouslySetInnerHTML={{ __html: themeCss }} />}
        {/* Block pinch-to-zoom on iOS Safari */}
        <script dangerouslySetInnerHTML={{ __html: `
          document.addEventListener('gesturestart', function(e) { e.preventDefault(); }, { passive: false });
          document.addEventListener('gesturechange', function(e) { e.preventDefault(); }, { passive: false });
          document.addEventListener('gestureend', function(e) { e.preventDefault(); }, { passive: false });
          document.addEventListener('touchmove', function(e) { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
        `}} />
      </head>
      <body className="min-h-screen bg-bg text-text">{children}</body>
    </html>
  );
}
