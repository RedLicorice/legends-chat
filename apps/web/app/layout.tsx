import type { Metadata, Viewport } from "next";
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
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
