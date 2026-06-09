import { NextResponse } from "next/server";
import { getCurrentUser, getUserMute } from "@/lib/auth";
import { getSettingCached } from "@/lib/settings-cache";
import { psPasskeyCount, psTopicBySlug, psTopicUserGrants } from "@/lib/db-prepared";
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

  const [topicRows, mute, giphySetting, passkeyRows] = await Promise.all([
    psTopicBySlug.execute({ slug }),
    getUserMute(user.id),
    getSettingCached("giphy_enabled"),
    psPasskeyCount.execute({ userId: user.id }),
  ]);
  const topic = topicRows[0];
  const passkeyCount = passkeyRows[0]?.n ?? 0;
  if (!topic) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const viewRoles = (topic.viewRoles as string[] | null) ?? [];
  if (viewRoles.length > 0 && user.role !== "admin" && !viewRoles.includes(user.role)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const readRoles = (topic.readRoles as string[] | null) ?? [];
  if (readRoles.length > 0 && user.role !== "admin" && !readRoles.includes(user.role)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const userGrantRows = await psTopicUserGrants.execute({
    topicId: topic.id,
    principalId: user.id,
  });
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
