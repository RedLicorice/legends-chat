import { NextResponse } from "next/server";
import { and, eq, gt, count, isNull, or } from "drizzle-orm";
import { topics, passkeyCredentials, topicPrincipalGrants } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser, getUserMute } from "@/lib/auth";
import { getSettingCached } from "@/lib/settings-cache";
import { canPrincipal, type TopicGrant, type GrantEffect } from "@legends/shared";

export const dynamic = "force-dynamic";

// GET /api/topic/[slug]
// Lean topic payload. Sidebar (chatItems), identity (user), and global
// branding/feature flags are NOT included here — they're fetched once per
// session via /api/chat-list, /api/me, and /api/branding respectively.
//
// 401 → unauthenticated. 404 → topic missing OR user's role can't view/read it
// (admins bypass role gates).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [topic, mute, giphySetting, passkeyCount] = await Promise.all([
    db.select().from(topics).where(eq(topics.slug, slug)).limit(1).then((r) => r[0]),
    getUserMute(user.id),
    getSettingCached("giphy_enabled"),
    db.select({ n: count() }).from(passkeyCredentials).where(eq(passkeyCredentials.userId, user.id)).then((r) => r[0]?.n ?? 0),
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
    canPost,
    canReply,
  });
}
