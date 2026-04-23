import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listTopicsForUser } from "@/lib/topics";
import { TopicListItem } from "@/components/TopicListItem";
import { PushSetup } from "@/components/PushSetup";
import { HomeHeader } from "@/components/HomeHeader";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const topics = await listTopicsForUser(user.id, user.role);

  const homeTopic = topics.find((t) => t.isHomeTopic);
  if (homeTopic) redirect(`/t/${homeTopic.slug}`);

  return (
    <div className="flex h-screen flex-col">
      <PushSetup />
      <HomeHeader user={{ id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl, role: user.role, presenceOptOut: user.presenceOptOut, permissions: [...user.permissions] }} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-xl py-4 px-3">
          <div className="mb-4 px-1">
            <h1 className="text-xl font-semibold">Topics</h1>
            <p className="text-sm text-muted">{topics.length} channel{topics.length === 1 ? "" : "s"}</p>
          </div>
          {topics.length === 0 ? (
            <div className="p-8 text-center text-muted">No topics yet. Ask an admin to create one.</div>
          ) : (
            topics.map((t) => <TopicListItem key={t.id} topic={t} />)
          )}
        </div>
      </main>
    </div>
  );
}
