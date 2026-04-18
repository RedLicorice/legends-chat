import { redirect, notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { topics } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser, getUserMute } from "@/lib/auth";
import { SideMenu } from "@/components/SideMenu";
import { TopicView } from "@/components/TopicView";

export const dynamic = "force-dynamic";

export default async function TopicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [topic] = await db.select().from(topics).where(eq(topics.slug, slug)).limit(1);
  if (!topic) notFound();

  const mute = await getUserMute(user.id);

  return (
    <div className="flex">
      <SideMenu user={user} />
      <main className="flex h-screen flex-1 flex-col">
        <TopicView
          topic={{ id: topic.id, slug: topic.slug, title: topic.title, isE2ee: topic.isE2ee }}
          currentUser={{ id: user.id, displayName: user.displayName, role: user.role }}
          mute={mute ? { reason: mute.reason, expiresAt: mute.expiresAt?.toISOString() ?? null } : null}
        />
      </main>
    </div>
  );
}
