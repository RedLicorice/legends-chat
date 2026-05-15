import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { unstable_cache } from "next/cache";
import "./globals.css";
import { getSetting } from "@legends/db/system-settings";
import { db } from "@/lib/db";
import { themes } from "@legends/db/schema";
import { asc } from "drizzle-orm";
import { PushSetup } from "@/components/PushSetup";
import { TokenRefresh } from "@/components/TokenRefresh";
import { SymbolsProvider } from "@/contexts/SymbolsContext";
import { ExternalLinkProvider, parseWhitelist } from "@/contexts/ExternalLinkContext";
import { ExternalLinkDialog } from "@/components/ExternalLinkDialog";

export const dynamic = "force-dynamic";

const getCachedBranding = unstable_cache(
  async () => {
    const [name, iconUrl] = await Promise.all([
      getSetting(db, "community_name").catch(() => null),
      getSetting(db, "pwa_icon_url").catch(() => null),
    ]);
    return { name, iconUrl };
  },
  ["layout-branding"],
  { revalidate: 300 },
);

const getCachedThemeColor = unstable_cache(
  async () => getSetting(db, "theme_accent_color").catch(() => null),
  ["layout-theme-color"],
  { revalidate: 300 },
);

const getCachedThemes = unstable_cache(
  async () => db.select().from(themes).orderBy(asc(themes.createdAt)).catch(() => []),
  ["layout-themes"],
  { revalidate: 300 },
);

const getCachedLayoutSettings = unstable_cache(
  async () => {
    const [defaultTheme, sidebarCompactDefault, interstitialEnabledRaw, whitelistRaw] = await Promise.all([
      getSetting(db, "default_theme").catch(() => null),
      getSetting(db, "sidebar_compact_default").catch(() => null),
      getSetting(db, "external_link_interstitial_enabled").catch(() => null),
      getSetting(db, "external_link_whitelist").catch(() => null),
    ]);
    return { defaultTheme, sidebarCompactDefault, interstitialEnabledRaw, whitelistRaw };
  },
  ["layout-settings"],
  { revalidate: 300 },
);

export async function generateMetadata(): Promise<Metadata> {
  const { name, iconUrl } = await getCachedBranding();
  const icon = iconUrl ?? "/icon-192.png";

  return {
    title: name ?? "Legends Chat",
    description: "Community chat",
    icons: {
      icon: [{ url: icon }],
      apple: [{ url: icon }],
    },
    appleWebApp: {
      capable: true,
      title: name ?? "Legends Chat",
      statusBarStyle: "black-translucent",
    },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const accentColor = await getCachedThemeColor();
  return {
    themeColor: accentColor ?? "#0b0d12",
    width: "device-width",
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
    viewportFit: "cover",
    interactiveWidget: "resizes-content",
  };
}

function buildThemeCss(
  themeRows: { id: string; colors: Record<string, string>; isGlass: boolean; bgGradient: string | null; customCss?: string | null }[],
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

    if (t.customCss) {
      // Strip </style> tags to prevent injection, then append
      css += t.customCss.replace(/<\/style>/gi, "");
    }

    return css;
  }).join("");
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const userTheme = jar.get("lc_theme")?.value;
  const userSidebarCompact = jar.get("lc_sidebar_compact")?.value;

  const [allThemes, { defaultTheme, sidebarCompactDefault, interstitialEnabledRaw, whitelistRaw }] = await Promise.all([
    getCachedThemes(),
    getCachedLayoutSettings(),
  ]);

  const resolvedSidebarCompact = userSidebarCompact ?? sidebarCompactDefault ?? "minimal";

  const externalLinkConfig = {
    interstitialEnabled: interstitialEnabledRaw !== "false", // default on
    whitelist: parseWhitelist(whitelistRaw),
    publicOrigin: process.env.APP_PUBLIC_URL ?? null,
  };

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
      customCss: t.customCss,
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
      <body className="bg-bg text-text">
        <PushSetup />
        <TokenRefresh />
        <ExternalLinkProvider config={externalLinkConfig}>
          <SymbolsProvider>{children}</SymbolsProvider>
          <ExternalLinkDialog />
        </ExternalLinkProvider>
      </body>
    </html>
  );
}
