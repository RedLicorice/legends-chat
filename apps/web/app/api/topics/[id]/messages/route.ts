import { and, asc, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { encryptionKeys, messages, topics, users } from "@legends/db/schema";
import { decryptMessage, unwrapKey } from "@legends/crypto";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

const keyCache = new Map<string, Uint8Array>();
async function getKey(keyId: string): Promise<Uint8Array> {
  const cached = keyCache.get(keyId);
  if (cached) return cached;
  const [row] = await db.select().from(encryptionKeys).where(eq(encryptionKeys.id, keyId)).limit(1);
  if (!row) throw new Error("key not found");
  const data = unwrapKey(row.wrappedKey);
  keyCache.set(keyId, data);
  return data;
}

// GET /api/topics/[id]/messages?replyTo=<messageId>
// Returns all messages that are replies to the given message (thread view).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: topicId } = await params;
  const { searchParams } = new URL(req.url);
  const replyTo = searchParams.get("replyTo");
  if (!replyTo) return NextResponse.json({ error: "replyTo required" }, { status: 400 });

  const [topic] = await db.select({ isE2ee: topics.isE2ee }).from(topics).where(eq(topics.id, topicId)).limit(1);
  if (!topic) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rows = await db
    .select({
      id: messages.id,
      topicId: messages.topicId,
      senderUserId: messages.senderUserId,
      botId: messages.botId,
      replyToMessageId: messages.replyToMessageId,
      contentCiphertext: messages.contentCiphertext,
      contentNonce: messages.contentNonce,
      keyId: messages.keyId,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      senderDisplayName: users.displayName,
      senderAvatarUrl: users.avatarUrl,
      senderIsAnon: users.isAnon,
    })
    .from(messages)
    .leftJoin(users, eq(messages.senderUserId, users.id))
    .where(
      and(
        eq(messages.topicId, topicId),
        eq(messages.replyToMessageId, BigInt(replyTo)),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(asc(messages.id));

  const aad = new TextEncoder().encode(topicId);
  const out = [];
  for (const r of rows) {
    let text = "";
    if (topic.isE2ee) {
      text = "(encrypted)";
    } else {
      try {
        const key = await getKey(r.keyId);
        const raw = decryptMessage(key, r.contentCiphertext, r.contentNonce, aad);
        try {
          const parsed = JSON.parse(raw) as { v?: number; t?: string };
          text = parsed.v === 1 && typeof parsed.t === "string" ? parsed.t : raw;
        } catch {
          text = raw;
        }
      } catch {
        text = "(unavailable)";
      }
    }
    out.push({
      id: r.id.toString(),
      topicId: r.topicId,
      senderUserId: r.senderUserId,
      senderDisplayName: r.senderDisplayName ?? null,
      senderAvatarUrl: r.senderAvatarUrl ?? null,
      senderIsAnon: r.senderIsAnon ?? false,
      botId: r.botId,
      replyToMessageId: r.replyToMessageId?.toString() ?? null,
      text,
      attachments: [],
      createdAt: r.createdAt,
      editedAt: r.editedAt,
    });
  }

  return NextResponse.json(out);
}
