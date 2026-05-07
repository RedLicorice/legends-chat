import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { encryptionKeys, messages, topicMembers, topics } from "@legends/db/schema";
import { decryptMessage, unwrapKey } from "@legends/crypto";
import { db } from "./db";

const keyDataCache = new Map<string, Uint8Array>();
async function getKeyData(keyId: string): Promise<Uint8Array> {
  const cached = keyDataCache.get(keyId);
  if (cached) return cached;
  const [row] = await db.select().from(encryptionKeys).where(eq(encryptionKeys.id, keyId)).limit(1);
  if (!row) throw new Error(`encryption key ${keyId} not found`);
  const data = unwrapKey(row.wrappedKey);
  keyDataCache.set(keyId, data);
  return data;
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
  const tRows = await db
    .select()
    .from(topics)
    .orderBy(desc(topics.isSticky), asc(topics.sortOrder), asc(topics.title));

  const out: TopicListItem[] = [];
  for (const t of tRows) {
    const viewRoles = (t.viewRoles as string[] | null) ?? [];
    if (viewRoles.length > 0 && userRole !== "admin" && !viewRoles.includes(userRole)) continue;
    const readRoles = (t.readRoles as string[] | null) ?? [];
    if (readRoles.length > 0 && userRole !== "admin" && !readRoles.includes(userRole)) continue;
    const [member] = await db
      .select()
      .from(topicMembers)
      .where(and(eq(topicMembers.topicId, t.id), eq(topicMembers.userId, userId)))
      .limit(1);

    const [latest] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.topicId, t.id), isNull(messages.deletedAt)))
      .orderBy(desc(messages.id))
      .limit(1);

    let unreadCount = 0;
    if (latest) {
      const lastRead = member?.lastReadMessageId ?? 0n;
      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(
            eq(messages.topicId, t.id),
            isNull(messages.deletedAt),
            gt(messages.id, lastRead),
          ),
        );
      unreadCount = Number(countRows[0]?.count ?? 0);
    }

    let lastMessage: TopicListItem["lastMessage"] = null;
    if (latest) {
      let preview = "";
      if (!t.isE2ee) {
        try {
          const key = await getKeyData(latest.keyId);
          const aad = new TextEncoder().encode(t.id);
          const raw = decryptMessage(key, latest.contentCiphertext, latest.contentNonce, aad);
          try {
            const parsed = JSON.parse(raw) as { v?: number; t?: string; a?: { type: string }[] };
            if (parsed.v === 1) {
              if (parsed.t?.trim()) {
                preview = parsed.t.slice(0, 120);
              } else if (parsed.a?.length) {
                const type = parsed.a[0]?.type ?? "attachment";
                preview = type === "image" ? "📷 Image" : "📎 Attachment";
              }
            } else {
              preview = raw.slice(0, 120);
            }
          } catch {
            preview = raw.slice(0, 120);
          }
        } catch {
          preview = "(unavailable)";
        }
      } else {
        preview = "(encrypted)";
      }
      lastMessage = {
        id: latest.id.toString(),
        preview,
        at: latest.createdAt,
        senderId: latest.senderUserId,
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
