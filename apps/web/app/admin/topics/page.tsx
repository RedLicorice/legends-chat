import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { AdminTopicsForm } from "@/components/AdminTopicsForm";
import { db } from "@/lib/db";
import { topics } from "@legends/db/schema";

export const dynamic = "force-dynamic";

export default async function AdminTopicsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) redirect("/");

  const topicList = await db.select().from(topics).orderBy(asc(topics.sortOrder), asc(topics.title));

  return (
    <main className="flex-1 p-4 sm:p-8">
        <h1 className="mb-2 text-2xl font-semibold">Topics</h1>
        <p className="mb-6 text-sm text-muted">Configure feed mode, home topic, and post permissions.</p>
        <AdminTopicsForm topics={topicList.map((t) => ({
          id: t.id,
          slug: t.slug,
          title: t.title,
          description: t.description,
          iconUrl: t.iconUrl ?? null,
          isSticky: t.isSticky,
          sortOrder: t.sortOrder,
          isFeed: t.isFeed,
          isHomeTopic: t.isHomeTopic,
          isE2ee: t.isE2ee,
          isP2p: t.isP2p,
          p2pFallbackE2ee: t.p2pFallbackE2ee,
          p2pMaxParticipants: t.p2pMaxParticipants ?? null,
          viewRoles: (t.viewRoles as string[] | null) ?? [],
          postRoles: (t.postRoles as string[] | null) ?? [],
          readRoles: (t.readRoles as string[] | null) ?? [],
          autoDeleteMode: t.autoDeleteMode,
          autoDeleteAgeSeconds: t.autoDeleteAgeSeconds,
          autoDeleteMaxMessages: t.autoDeleteMaxMessages,
        }))} />
    </main>
  );
}
