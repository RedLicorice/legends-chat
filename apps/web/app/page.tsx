import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listTopicsForUser } from "@/lib/topics";
import { listChatItems } from "@/lib/chat-list";
import { HomeLayout } from "@/components/HomeLayout";
import { db } from "@/lib/db";
import { getAllSettings } from "@legends/db/system-settings";
import { PWASplash } from "@/components/PWASplash";

async function HomeContent() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const topics = await listTopicsForUser(user.id, user.role, user.permissions);

  const homeTopic = topics.find((t) => t.isHomeTopic);
  if (homeTopic) redirect(`/t/${homeTopic.slug}`);

  const [chatItems, settings] = await Promise.all([
    listChatItems(user.id, user.role, user.permissions),
    getAllSettings(db),
  ]);
  const communityName = settings.community_name ?? "Topics";
  const communityBannerUrl = settings.community_banner_url ?? null;

  const bannerConfig = settings.banner_in_topics === "true" && communityBannerUrl ? {
    url: communityBannerUrl,
    height: parseInt(settings.banner_topic_height ?? "180", 10),
    overlap: parseInt(settings.banner_topic_overlap ?? "60", 10),
    overlayEnabled: settings.banner_overlay_enabled === "true",
    overlayOpacity: parseInt(settings.banner_overlay_opacity ?? "40", 10),
    fadeEnabled: settings.banner_fade_enabled !== "false",
  } : null;

  return (
    <HomeLayout
      communityName={communityName}
      communityBannerUrl={communityBannerUrl}
      bannerConfig={bannerConfig}
      user={{
        id: user.id,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        role: user.role,
        permissions: [...user.permissions],
        presenceOptOut: user.presenceOptOut,
      }}
      chatItems={chatItems}
    />
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<PWASplash />}>
      <HomeContent />
    </Suspense>
  );
}
