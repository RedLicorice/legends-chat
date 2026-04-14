import { and, desc, eq } from "drizzle-orm";
import {
  encryptionKeys,
  messageFlags,
  messages,
  users,
} from "@legends/db/schema";
import { decryptMessage, unwrapKey } from "@legends/crypto";
import { db } from "./db.js";

export interface ModerationFlagRow {
  id: string;
  createdAt: Date;
  reason: string;
  reporter: { id: string; displayName: string };
  message: {
    id: string;
    topicId: string;
    senderUserId: string | null;
    senderDisplayName: string | null;
    text: string;
    deletedAt: Date | null;
  };
}

const keyCache = new Map<string, Uint8Array>();
async function getKey(keyId: string): Promise<Uint8Array> {
  const cached = keyCache.get(keyId);
  if (cached) return cached;
  const [row] = await db.select().from(encryptionKeys).where(eq(encryptionKeys.id, keyId)).limit(1);
  if (!row) throw new Error(`encryption key ${keyId} not found`);
  const data = unwrapKey(row.wrappedKey);
  keyCache.set(keyId, data);
  return data;
}

export async function listPendingFlags(limit = 100): Promise<ModerationFlagRow[]> {
  const rows = await db
    .select({
      flag: messageFlags,
      msg: messages,
      reporter: users,
    })
    .from(messageFlags)
    .innerJoin(messages, eq(messageFlags.messageId, messages.id))
    .innerJoin(users, eq(messageFlags.reporterUserId, users.id))
    .where(eq(messageFlags.status, "pending"))
    .orderBy(desc(messageFlags.createdAt))
    .limit(limit);

  const out: ModerationFlagRow[] = [];
  for (const r of rows) {
    let text = "(unavailable)";
    try {
      const key = await getKey(r.msg.keyId);
      const aad = new TextEncoder().encode(r.msg.topicId);
      text = decryptMessage(key, r.msg.contentCiphertext, r.msg.contentNonce, aad);
    } catch {
      // leave as unavailable
    }
    let senderName: string | null = null;
    if (r.msg.senderUserId) {
      const [s] = await db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, r.msg.senderUserId))
        .limit(1);
      senderName = s?.displayName ?? null;
    }
    out.push({
      id: r.flag.id,
      createdAt: r.flag.createdAt,
      reason: r.flag.reason,
      reporter: { id: r.reporter.id, displayName: r.reporter.displayName },
      message: {
        id: r.msg.id.toString(),
        topicId: r.msg.topicId,
        senderUserId: r.msg.senderUserId,
        senderDisplayName: senderName,
        text,
        deletedAt: r.msg.deletedAt,
      },
    });
  }
  return out;
}

export async function resolveFlag(args: {
  flagId: string;
  reviewerUserId: string;
  status: "dismissed" | "actioned";
}): Promise<void> {
  await db
    .update(messageFlags)
    .set({ status: args.status, reviewedByUserId: args.reviewerUserId, reviewedAt: new Date() })
    .where(and(eq(messageFlags.id, args.flagId), eq(messageFlags.status, "pending")));
}

export async function softDeleteMessage(messageId: string): Promise<void> {
  await db
    .update(messages)
    .set({ deletedAt: new Date() })
    .where(eq(messages.id, BigInt(messageId)));
}
