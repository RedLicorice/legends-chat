import type { MetadataRoute } from "next";
import { getSetting } from "@legends/db/system-settings";
import { db } from "@/lib/db";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const [name, iconUrl] = await Promise.all([
    getSetting(db, "community_name").catch(() => null),
    getSetting(db, "pwa_icon_url").catch(() => null),
  ]);

  const icons: MetadataRoute.Manifest["icons"] = iconUrl
    ? [
        { src: iconUrl, sizes: "512x512", type: "image/png", purpose: "maskable" },
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ]
    : [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ];

  return {
    name: name ?? "Legends Chat",
    short_name: name ? name.split(" ")[0] : "Legends",
    description: "Community chat",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0d12",
    theme_color: "#0b0d12",
    icons,
  };
}
