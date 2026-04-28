import type { MetadataRoute } from "next";
import { asc } from "drizzle-orm";
import { getSetting } from "@legends/db/system-settings";
import { topics } from "@legends/db/schema";
import { db } from "@/lib/db";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const [name, iconUrl, accentColor, topicList] = await Promise.all([
    getSetting(db, "community_name").catch(() => null),
    getSetting(db, "pwa_icon_url").catch(() => null),
    getSetting(db, "theme_accent_color").catch(() => null),
    db.select({ title: topics.title, slug: topics.slug, iconUrl: topics.iconUrl })
      .from(topics)
      .orderBy(asc(topics.sortOrder))
      .limit(4)
      .catch(() => []),
  ]);

  const themeColor = accentColor ?? "#7c5cff";

  const icons: MetadataRoute.Manifest["icons"] = iconUrl
    ? [
        { src: iconUrl, sizes: "512x512", type: "image/png", purpose: "any maskable" },
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      ]
    : [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ];

  const shortcuts: MetadataRoute.Manifest["shortcuts"] = [
    ...topicList.map((t) => ({
      name: t.title,
      url: `/t/${t.slug}`,
      icons: t.iconUrl
        ? [{ src: t.iconUrl, sizes: "96x96", type: "image/png" }]
        : [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    })),
    {
      name: "Settings",
      url: "/settings",
      icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    },
  ];

  return {
    name: name ?? "Legends Chat",
    short_name: name ? name.split(" ")[0] : "Legends",
    description: "Community chat",
    start_url: "/",
    display: "fullscreen",
    orientation: "portrait",
    background_color: "#0b0d12",
    theme_color: themeColor,
    icons,
    shortcuts,
  };
}
