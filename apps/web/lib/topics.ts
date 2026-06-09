import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { encryptionKeys, topicPrincipalGrants, topics } from "@legends/db/schema";
import { decryptMessage, unwrapKey } from "@legends/crypto";
import { canPrincipal, stripMarkdownPreview, type GrantEffect, type TopicGrant } from "@legends/shared";
import { db } from "./db";

const keyDataCache = new Map<string, Uint8Array>();
async function getKeyDataBatch(keyIds: string[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const missing: string[] = [];
  for (const id of keyIds) {
    const cached = keyDataCache.get(id);
    if (cached) out.set(id, cached);
    else missing.push(id);
  }
  if (missing.length === 0) return out;
  const rows = await db.select().from(encryptionKeys).where(inArray(encryptionKeys.id, missing));
  for (const row of rows) {
    const data = unwrapKey(row.wrappedKey);
    keyDataCache.set(row.id, data);
    out.set(row.id, data);
  }
  return out;
}

export interface TopicListItem {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  isSticky: boolean;
  isE2ee: boolean;
  isP2p: boolean;
  p2pFallbackE2ee: boolean;
  isFeed: boolean;
  isHomeTopic: boolean;
  postRoles: string[];
  unreadCount: number;
  lastMessage: { id: string; preview: string; at: Date; senderId: string | null } | null;
}

export async function listTopicsForUser(userId: string, userRole: string, userPermissions: Set<string>): Promise<TopicListItem[]> {
  const now = new Date();
  const [tRows, grantRows] = await Promise.all([
    db
      .select()
      .from(topics)
      .orderBy(desc(topics.isSticky), asc(topics.sortOrder), asc(topics.title)),
    db
      .select({ topicId: topicPrincipalGrants.topicId, action: topicPrincipalGrants.action, effect: topicPrincipalGrants.effect })
      .from(topicPrincipalGrants)
      .where(
        and(
          eq(topicPrincipalGrants.principalType, "user"),
          eq(topicPrincipalGrants.principalId, userId),
          or(isNull(topicPrincipalGrants.expiresAt), gt(topicPrincipalGrants.expiresAt, now)),
        ),
      ),
  ]);

  const grantsByTopic = new Map<string, TopicGrant[]>();
  for (const g of grantRows) {
    const arr = grantsByTopic.get(g.topicId) ?? [];
    arr.push({ action: g.action, effect: g.effect as GrantEffect });
    grantsByTopic.set(g.topicId, arr);
  }

  const visibleTopics = tRows.filter((t) => {
    const grants = grantsByTopic.get(t.id) ?? [];
    const viewRoles = (t.viewRoles as string[] | null) ?? [];
    const readRoles = (t.readRoles as string[] | null) ?? [];
    return canPrincipal(grants, viewRoles, userRole, "view")
      && canPrincipal(grants, readRoles, userRole, "read");
  });

  if (visibleTopics.length === 0) return [];

  const topicIds = visibleTopics.map((t) => t.id);

  // One bundled query: per-topic membership + latest non-deleted message + unread count.
  // LATERAL subqueries scan messages_topic_id_idx exactly twice per topic (latest +
  // unread count), and the LEFT JOIN against topic_members hits the (topic_id,user_id)
  // primary key. Avoids the previous 3*N awaited round-trips.
  type BundledRow = {
    topic_id: string;
    last_read_message_id: string | null;
    joined_at: Date | null;
    latest_id: string | null;
    latest_created_at: Date | null;
    latest_content_ciphertext: Uint8Array | null;
    latest_content_nonce: Uint8Array | null;
    latest_sender_user_id: string | null;
    latest_key_id: string | null;
    unread_count: number;
  };
  const bundled = await db.execute<BundledRow>(sql`
    SELECT
      t.id AS topic_id,
      tm.last_read_message_id,
      tm.joined_at,
      latest.id AS latest_id,
      latest.created_at AS latest_created_at,
      latest.content_ciphertext AS latest_content_ciphertext,
      latest.content_nonce AS latest_content_nonce,
      latest.sender_user_id AS latest_sender_user_id,
      latest.key_id AS latest_key_id,
      COALESCE(unread.n, 0)::int AS unread_count
    FROM topics t
    LEFT JOIN topic_members tm
      ON tm.topic_id = t.id AND tm.user_id = ${userId}
    LEFT JOIN LATERAL (
      SELECT m.id, m.created_at, m.content_ciphertext, m.content_nonce, m.sender_user_id, m.key_id
      FROM messages m
      WHERE m.topic_id = t.id AND m.deleted_at IS NULL
      ORDER BY m.id DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS n
      FROM messages m
      WHERE m.topic_id = t.id
        AND m.deleted_at IS NULL
        AND m.id > COALESCE(tm.last_read_message_id, 0)
    ) unread ON true
    WHERE t.id IN (${sql.join(topicIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `);

  const perTopic = new Map<string, BundledRow>();
  for (const row of Array.from(bundled) as BundledRow[]) perTopic.set(row.topic_id, row);

  const keyIds = new Set<string>();
  for (const t of visibleTopics) {
    if (t.isE2ee) continue;
    const row = perTopic.get(t.id);
    if (row?.latest_key_id) keyIds.add(row.latest_key_id);
  }
  const keys = keyIds.size > 0 ? await getKeyDataBatch([...keyIds]) : new Map<string, Uint8Array>();

  const out: TopicListItem[] = [];
  for (const t of visibleTopics) {
    const row = perTopic.get(t.id);
    const unreadCount = row ? Number(row.unread_count ?? 0) : 0;

    let lastMessage: TopicListItem["lastMessage"] = null;
    if (row?.latest_id) {
      let preview = "";
      if (!t.isE2ee && row.latest_key_id && row.latest_content_ciphertext && row.latest_content_nonce) {
        const key = keys.get(row.latest_key_id);
        if (key) {
          try {
            const aad = new TextEncoder().encode(t.id);
            const raw = decryptMessage(key, row.latest_content_ciphertext, row.latest_content_nonce, aad);
            try {
              const parsed = JSON.parse(raw) as { v?: number; t?: string; a?: { type: string }[] };
              if (parsed.v === 1) {
                if (parsed.t?.trim()) {
                  preview = stripMarkdownPreview(parsed.t, t.isFeed);
                } else if (parsed.a?.length) {
                  const type = parsed.a[0]?.type ?? "attachment";
                  preview = type === "image" ? "📷 Image" : "📎 Attachment";
                }
              } else {
                preview = stripMarkdownPreview(raw, t.isFeed);
              }
            } catch {
              preview = stripMarkdownPreview(raw, t.isFeed);
            }
          } catch {
            preview = "(unavailable)";
          }
        } else {
          preview = "(unavailable)";
        }
      }
      lastMessage = {
        id: row.latest_id.toString(),
        preview,
        at: row.latest_created_at ? new Date(row.latest_created_at) : new Date(0),
        senderId: row.latest_sender_user_id,
      };
    }

    out.push({
      id: t.id,
      slug: t.slug,
      title: t.title,
      description: t.description,
      iconUrl: t.iconUrl ?? null,
      bannerUrl: t.bannerUrl ?? null,
      isSticky: t.isSticky,
      isE2ee: t.isE2ee,
      isP2p: t.isP2p,
      p2pFallbackE2ee: t.p2pFallbackE2ee,
      isFeed: t.isFeed,
      isHomeTopic: t.isHomeTopic,
      postRoles: (t.postRoles as string[] | null) ?? [],
      unreadCount,
      lastMessage,
    });
  }
  return out;
}
