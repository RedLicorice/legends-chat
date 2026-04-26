import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listTopicsForUser } from "@/lib/topics";
import { HomeLayout } from "@/components/HomeLayout";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const topics = await listTopicsForUser(user.id, user.role);

  const homeTopic = topics.find((t) => t.isHomeTopic);
  if (homeTopic) redirect(`/t/${homeTopic.slug}`);

  return (
    <HomeLayout
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
