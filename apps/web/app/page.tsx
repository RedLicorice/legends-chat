import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listTopicsForUser } from "@/lib/topics";
import { SideMenu } from "@/components/SideMenu";
import { TopicListItem } from "@/components/TopicListItem";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const topics = await listTopicsForUser(user.id);

  return (
    <div className="flex">
      <SideMenu user={user} />
      <main className="flex h-screen flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold">Topics</h1>
            <p className="text-sm text-muted">{topics.length} channel{topics.length === 1 ? "" : "s"}</p>
          </div>
        </header>
        <div className="flex-1 space-y-1 overflow-y-auto p-3">
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
