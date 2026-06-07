import { NextResponse } from "next/server";
import { and, eq, gt, count, isNull, or } from "drizzle-orm";
import { topics, passkeyCredentials, topicPrincipalGrants } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser, getUserMute } from "@/lib/auth";
import { listChatItems } from "@/lib/chat-list";
import { getSetting } from "@legends/db/system-settings";
import { canPrincipal, type TopicGrant, type GrantEffect } from "@legends/shared";

export const dynamic = "force-dynamic";

// GET /api/topic/[slug]
// Returns the full payload needed to render <TopicLayout /> on the client.
// Mirrors the server-side gating that the previous SSR page.tsx performed:
//   - 401 if unauthenticated (defence-in-depth on top of middleware)
//   - 404 if the topic does not exist
//   - 404 if the user's role isn't allowed to view or read the topic
//     (admins bypass these role gates, matching the SSR behaviour)
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [topic, chatItems, mute, giphySetting, passkeyCount, communityName, communityIconUrl] = await Promise.all([
    db.select().from(topics).where(eq(topics.slug, slug)).limit(1).then((r) => r[0]),
    listChatItems(user.id, user.role, user.permissions),
    getUserMute(user.id),
    getSetting(db, "giphy_enabled"),
    db.select({ n: count() }).from(passkeyCredentials).where(eq(passkeyCredentials.userId, user.id)).then((r) => r[0]?.n ?? 0),
    getSetting(db, "community_name").catch(() => null),
    getSetting(db, "pwa_icon_url").catch(() => null),
  ]);
  if (!topic) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const viewRoles = (topic.viewRoles as string[] | null) ?? [];
  if (viewRoles.length > 0 && user.role !== "admin" && !viewRoles.includes(user.role)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const readRoles = (topic.readRoles as string[] | null) ?? [];
  if (readRoles.length > 0 && user.role !== "admin" && !readRoles.includes(user.role)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const now = new Date();
  const userGrantRows = await db
    .select({ action: topicPrincipalGrants.action, effect: topicPrincipalGrants.effect })
    .from(topicPrincipalGrants)
    .where(
      and(
        eq(topicPrincipalGrants.topicId, topic.id),
        eq(topicPrincipalGrants.principalType, "user"),
        eq(topicPrincipalGrants.principalId, user.id),
        or(isNull(topicPrincipalGrants.expiresAt), gt(topicPrincipalGrants.expiresAt, now)),
      ),
    );
  const userGrants: TopicGrant[] = userGrantRows.map((g) => ({ action: g.action, effect: g.effect as GrantEffect }));

  const canPost = canPrincipal(userGrants, (topic.postRoles as string[] | null) ?? [], user.role, "post");
  const canReply = topic.isFeed
    ? canPrincipal(userGrants, (topic.replyRoles as string[] | null) ?? [], user.role, "reply")
    : canPost;

  return NextResponse.json({
    user: {
      id: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role: user.role,
      permissions: [...user.permissions],
      presenceOptOut: user.presenceOptOut,
    },
    chatItems,
    topic: {
      id: topic.id,
      slug: topic.slug,
      title: topic.title,
      isE2ee: topic.isE2ee,
      isP2p: topic.isP2p,
      p2pFallbackE2ee: topic.p2pFallbackE2ee,
      isFeed: topic.isFeed,
      postRoles: (topic.postRoles as string[] | null) ?? [],
      replyRoles: (topic.replyRoles as string[] | null) ?? [],
      iconUrl: topic.iconUrl ?? null,
      bannerUrl: topic.bannerUrl ?? null,
      description: topic.description ?? null,
      hasPassword: topic.passwordHash != null,
      passwordVersion: topic.passwordVersion,
      passwordReentryDays: topic.passwordReentryDays,
    },
    mute: mute ? { reason: mute.reason, expiresAt: mute.expiresAt?.toISOString() ?? null } : null,
    hasPasskey: passkeyCount > 0,
    giphyEnabled: giphySetting === "true",
    communityName: communityName ?? null,
    communityIconUrl: communityIconUrl ?? null,
    canPost,
    canReply,
  });
}
