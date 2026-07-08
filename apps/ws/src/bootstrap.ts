import {
  PERMISSIONS,
  canPrincipal,
  type AccessTokenPayload,
  type GrantEffect,
  type SessionBootstrap,
  type TopicBootstrap,
  type TopicGrant,
} from "@legends/shared";
import {
  psPasskeyCount,
  psPendingFlagCount,
  psRecentNotifications,
  psSymbols,
  psSystemSetting,
  psTopicById,
  psTopicBySlug,
  psTopicMembers,
  psTopicUserGrants,
  psUserMute,
} from "./db-prepared";
import { cacheClient } from "./redis";

// UUIDv4 pattern — used to decide whether the slug-or-id from the client
// should be probed as a UUID first. Cheap regex check beats catching an
// invalid-uuid pg error on every slug join.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TopicBootstrapResult =
  | { ok: true; data: TopicBootstrap; topicId: string }
  | { ok: false; error: "not_found" | "forbidden" };

// Mirrors the gating contract of apps/web/app/api/topic/[slug]/route.ts —
// keep both in sync if the gating ever changes. The REST route stays for
// cold-load fallback when no socket is connected yet.
export async function buildTopicBootstrap(
  user: AccessTokenPayload,
  slugOrId: string,
): Promise<TopicBootstrapResult> {
  const isUuid = UUID_RE.test(slugOrId);
  const topicRows = isUuid
    ? await psTopicById.execute({ id: slugOrId })
    : await psTopicBySlug.execute({ slug: slugOrId });
  const topic = topicRows[0];
  if (!topic) return { ok: false, error: "not_found" };

  const viewRoles = (topic.viewRoles as string[] | null) ?? [];
  if (viewRoles.length > 0 && user.role !== "admin" && !viewRoles.includes(user.role)) {
    return { ok: false, error: "not_found" };
  }
  const readRoles = (topic.readRoles as string[] | null) ?? [];
  if (readRoles.length > 0 && user.role !== "admin" && !readRoles.includes(user.role)) {
    return { ok: false, error: "not_found" };
  }

  // Password gate is server-authoritative (#19): a protected topic only yields
  // its history/live feed to a caller who has proven the password. The proof
  // (current passwordVersion) is set by POST /api/topics/[id]/verify-password.
  // Admins bypass, matching the client gate.
  if (topic.passwordHash != null && user.role !== "admin") {
    const proof = await cacheClient.get(`legends:topic-pw:${user.sub}:${topic.id}`);
    if (proof !== String(topic.passwordVersion)) {
      return { ok: false, error: "forbidden" };
    }
  }

  const [muteRows, passkeyRows, grantRows, memberRows, hashtagRows, giphySetting] = await Promise.all([
    psUserMute.execute({ userId: user.sub }),
    psPasskeyCount.execute({ userId: user.sub }),
    psTopicUserGrants.execute({ topicId: topic.id, principalId: user.sub }),
    psTopicMembers.execute({ topicId: topic.id }),
    loadTopicHashtags(topic.id),
    psSystemSetting.execute({ key: "giphy_enabled" }),
  ]);

  const grants: TopicGrant[] = grantRows.map((g) => ({ action: g.action, effect: g.effect as GrantEffect }));
  const canPost = canPrincipal(grants, (topic.postRoles as string[] | null) ?? [], user.role, "post");
  const canReply = topic.isFeed
    ? canPrincipal(grants, (topic.replyRoles as string[] | null) ?? [], user.role, "reply")
    : canPost;

  const mute = muteRows[0];
  const passkeyCount = passkeyRows[0]?.n ?? 0;

  const data: TopicBootstrap = {
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
    giphyEnabled: giphySetting[0]?.value === "true",
    canPost,
    canReply,
    members: memberRows.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl ?? null,
      role: m.role,
      isAnon: m.isAnon,
      joinedAt: m.joinedAt.toISOString(),
    })),
    hashtags: hashtagRows,
  };
  return { ok: true, data, topicId: topic.id };
}

// Hashtag cloud isn't a clean prepared statement (uses unnest+group_by on
// an array column), so we keep it inline. Same SQL as
// /api/topics/[id]/hashtags so live updates from the topic dovetail with
// what bootstrap returned.
async function loadTopicHashtags(topicId: string): Promise<{ tag: string; count: number }[]> {
  const { db } = await import("./db");
  const { sql } = await import("drizzle-orm");
  const rows = await db.execute<{ tag: string; count: string }>(
    sql`
      SELECT tag, COUNT(*)::text AS count
      FROM messages, unnest(hashtags) AS tag
      WHERE topic_id = ${topicId}
        AND deleted_at IS NULL
        AND array_length(hashtags, 1) > 0
      GROUP BY tag
      ORDER BY COUNT(*) DESC
      LIMIT 100
    `,
  );
  return Array.from(rows).map((r) => ({ tag: r.tag, count: Number(r.count) }));
}

export async function buildSessionBootstrap(user: AccessTokenPayload): Promise<SessionBootstrap> {
  const canModQueue = user.permissions.includes(PERMISSIONS.MODERATION_QUEUE_REVIEW);
  const [symbols, notifRows, modFlagRows] = await Promise.all([
    psSymbols.execute(),
    psRecentNotifications.execute({ userId: user.sub }),
    canModQueue ? psPendingFlagCount.execute() : Promise.resolve(null),
  ]);
  const unread = notifRows.filter((n) => !n.readAt).length;
  return {
    symbols: symbols.map((s) => ({
      id: s.id,
      symbol: s.symbol,
      name: s.name,
      description: s.description ?? null,
      linkedUserId: s.linkedUserId ?? null,
      linkedUserDisplayName: s.linkedUserDisplayName ?? null,
      linkedUserAvatarUrl: s.linkedUserAvatarUrl ?? null,
    })),
    pushVapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null,
    notifications: {
      items: notifRows.map((n) => ({
        id: n.id,
        type: n.type,
        payload: n.payload,
        readAt: n.readAt ? n.readAt.toISOString() : null,
        createdAt: n.createdAt.toISOString(),
      })),
      unread,
    },
    modFlagCount: modFlagRows ? modFlagRows[0]?.n ?? 0 : null,
  };
}
