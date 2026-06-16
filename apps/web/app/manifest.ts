import type { MetadataRoute } from "next";
import { unstable_cache } from "next/cache";
import { asc } from "drizzle-orm";
import { getSetting } from "@legends/db/system-settings";
import { topics } from "@legends/db/schema";
import { db } from "@/lib/db";

const getCachedManifestData = unstable_cache(
  async () => {
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
    return { name, iconUrl, accentColor, topicList };
  },
  ["manifest-data"],
  { revalidate: 300 },
);

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { name, iconUrl, accentColor, topicList } = await getCachedManifestData();

  const themeColor = accentColor ?? "#7c5cff";

  // Admin-uploaded pwa_icon_url is NOT declared maskable: operators upload
  // a logo that fills the canvas edge-to-edge with no safe zone, so Chrome's
  // maskable safe-zone crop reveals the theme_color underneath (the "purple
  // square" symptom). Keep the system /icon-512.png as the maskable fallback
  // — it has a real safe zone. Browsers prefer the larger `any` icon for
  // normal install/favicon use anyway.
  const icons: MetadataRoute.Manifest["icons"] = iconUrl
    ? [
        { src: iconUrl, sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" as "any" },
      ]
    : [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" as "any" },
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
    start_url: "/login",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0d12",
    theme_color: themeColor,
    icons,
    shortcuts,
  };
}
