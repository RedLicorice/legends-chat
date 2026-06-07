import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listTopicsForUser } from "@/lib/topics";
import { listChatItems } from "@/lib/chat-list";
import { db } from "@/lib/db";
import { getAllSettings } from "@legends/db/system-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [topics, settings] = await Promise.all([
    listTopicsForUser(user.id, user.role, user.permissions),
    getAllSettings(db),
  ]);

  const homeTopic = topics.find((t) => t.isHomeTopic);
  const chatItems = await listChatItems(user.id, user.role, user.permissions);

  const communityName = settings.community_name ?? "Topics";
  const communityBannerUrl = settings.community_banner_url ?? null;
  const bannerConfig =
    settings.banner_in_topics === "true" && communityBannerUrl
      ? {
          url: communityBannerUrl,
          height: parseInt(settings.banner_topic_height ?? "180", 10),
          overlap: parseInt(settings.banner_topic_overlap ?? "60", 10),
          overlayEnabled: settings.banner_overlay_enabled === "true",
          overlayOpacity: parseInt(settings.banner_overlay_opacity ?? "40", 10),
          fadeEnabled: settings.banner_fade_enabled !== "false",
        }
      : null;

  return NextResponse.json({
    homeTopicSlug: homeTopic?.slug ?? null,
    chatItems,
    communityName,
    communityBannerUrl,
    bannerConfig,
  });
}
