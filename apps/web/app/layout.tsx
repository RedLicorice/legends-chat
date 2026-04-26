import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { getSetting } from "@legends/db/system-settings";
import { db } from "@/lib/db";

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

function hexToChannels(hex: string): string | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const r = parseInt(m[1]!.slice(0, 2), 16);
  const g = parseInt(m[1]!.slice(2, 4), 16);
  const b = parseInt(m[1]!.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const userTheme = jar.get("lc_theme")?.value;

  const [defaultTheme, accentHex] = await Promise.all([
    getSetting(db, "default_theme").catch(() => null),
    getSetting(db, "theme_accent_color").catch(() => null),
  ]);

  const validThemes = ["dark", "matte-glass"];
  const theme = validThemes.includes(userTheme ?? "") ? userTheme! : (validThemes.includes(defaultTheme ?? "") ? defaultTheme! : "dark");

  const accentChannels = accentHex ? hexToChannels(accentHex) : null;
  const customCss = accentChannels ? `:root,[data-theme]{--ch-accent:${accentChannels};}` : "";

  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <head>
        {customCss && <style dangerouslySetInnerHTML={{ __html: customCss }} />}
        {/* Block pinch-to-zoom on iOS Safari (ignores viewport user-scalable=no since iOS 10) */}
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
