import { redirect, notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { topics } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser, getUserMute } from "@/lib/auth";
import { listTopicsForUser } from "@/lib/topics";
import { TopicLayout } from "@/components/TopicLayout";

export const dynamic = "force-dynamic";

export default async function TopicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [topic, topicList, mute] = await Promise.all([
    db.select().from(topics).where(eq(topics.slug, slug)).limit(1).then((r) => r[0]),
    listTopicsForUser(user.id, user.role),
    getUserMute(user.id),
  ]);
  if (!topic) notFound();

  const readRoles = (topic.readRoles as string[] | null) ?? [];
  if (readRoles.length > 0 && user.role !== "admin" && !readRoles.includes(user.role)) notFound();

  return (
    <TopicLayout
      user={{ id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl, role: user.role, permissions: [...user.permissions], presenceOptOut: user.presenceOptOut }}
      topics={topicList}
      currentSlug={slug}
      topic={{ id: topic.id, slug: topic.slug, title: topic.title, isE2ee: topic.isE2ee, isFeed: topic.isFeed, postRoles: (topic.postRoles as string[] | null) ?? [] }}
      mute={mute ? { reason: mute.reason, expiresAt: mute.expiresAt?.toISOString() ?? null } : null}
    />
  );
}
