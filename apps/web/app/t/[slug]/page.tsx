import { redirect, notFound } from "next/navigation";
import { eq, gt, count } from "drizzle-orm";
import { topics, passkeyCredentials } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser, getUserMute } from "@/lib/auth";
import { listTopicsForUser } from "@/lib/topics";
import { getSetting } from "@legends/db/system-settings";
import { TopicLayout } from "@/components/TopicLayout";

export const dynamic = "force-dynamic";

export default async function TopicPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>)]);
  const highlightMessageId = typeof sp["msg"] === "string" ? sp["msg"] : undefined;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [topic, topicList, mute, giphySetting, passkeyCount] = await Promise.all([
    db.select().from(topics).where(eq(topics.slug, slug)).limit(1).then((r) => r[0]),
    listTopicsForUser(user.id, user.role, user.permissions),
    getUserMute(user.id),
    getSetting(db, "giphy_enabled"),
    db.select({ n: count() }).from(passkeyCredentials).where(eq(passkeyCredentials.userId, user.id)).then((r) => r[0]?.n ?? 0),
  ]);
  if (!topic) notFound();

  const viewRoles = (topic.viewRoles as string[] | null) ?? [];
  if (viewRoles.length > 0 && user.role !== "admin" && !viewRoles.includes(user.role)) notFound();
  const readRoles = (topic.readRoles as string[] | null) ?? [];
  if (readRoles.length > 0 && user.role !== "admin" && !readRoles.includes(user.role)) notFound();

  return (
    <TopicLayout
      user={{ id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl, role: user.role, permissions: [...user.permissions], presenceOptOut: user.presenceOptOut }}
      topics={topicList}
      currentSlug={slug}
      topic={{ id: topic.id, slug: topic.slug, title: topic.title, isE2ee: topic.isE2ee, isP2p: topic.isP2p, p2pFallbackE2ee: topic.p2pFallbackE2ee, isFeed: topic.isFeed, postRoles: (topic.postRoles as string[] | null) ?? [] }}
      mute={mute ? { reason: mute.reason, expiresAt: mute.expiresAt?.toISOString() ?? null } : null}
      hasPasskey={passkeyCount > 0}
      giphyEnabled={giphySetting === "true"}
      highlightMessageId={highlightMessageId}
    />
  );
}
