import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listTopicsForUser } from "@/lib/topics";
import { HomeLayout } from "@/components/HomeLayout";
import { db } from "@/lib/db";
import { getAllSettings } from "@legends/db/system-settings";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const topics = await listTopicsForUser(user.id, user.role, user.permissions);

  const homeTopic = topics.find((t) => t.isHomeTopic);
  if (homeTopic) redirect(`/t/${homeTopic.slug}`);

  const settings = await getAllSettings(db);
  const communityName = settings.community_name ?? "Topics";
  const communityBannerUrl = settings.community_banner_url ?? null;

  return (
    <HomeLayout
      communityName={communityName}
      communityBannerUrl={communityBannerUrl}
      user={{
        id: user.id,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        role: user.role,
        permissions: [...user.permissions],
        presenceOptOut: user.presenceOptOut,
      }}
      topics={topics}
    />
  );
}
