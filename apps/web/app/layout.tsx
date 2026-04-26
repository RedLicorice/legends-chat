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
      <body className="min-h-screen bg-bg text-text">{children}</body>
    </html>
  );
}
