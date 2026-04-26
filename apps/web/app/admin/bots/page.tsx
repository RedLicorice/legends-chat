import { redirect } from "next/navigation";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { AdminBotsForm } from "@/components/AdminBotsForm";
import { db } from "@/lib/db";
import { bots, topics, topicBots } from "@legends/db/schema";
import { asc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function AdminBotsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.permissions.has(PERMISSIONS.BOTS_MANAGE)) redirect("/");

  const [botList, topicList] = await Promise.all([
    db.select({ id: bots.id, name: bots.name, avatarUrl: bots.avatarUrl, webhookUrl: bots.webhookUrl, isActive: bots.isActive, createdAt: bots.createdAt }).from(bots).orderBy(bots.createdAt),
    db.select({ id: topics.id, title: topics.title, isE2ee: topics.isE2ee }).from(topics).orderBy(asc(topics.sortOrder), asc(topics.title)),
  ]);

  const assignments = await db.select({ botId: topicBots.botId, topicId: topicBots.topicId }).from(topicBots);

  return (
    <main className="flex-1 p-8">
        <h1 className="mb-2 text-2xl font-semibold">Bots</h1>
        <p className="mb-6 text-sm text-muted">Create and manage bots. Assign them to topics to receive message webhooks.</p>
        <AdminBotsForm
          bots={botList}
          topics={topicList}
          assignments={assignments}
        />
    </main>
  );
}
