import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { encryptionKeys, messages } from "@legends/db/schema";
import { REDIS_CHANNELS } from "@legends/shared";
import { decryptMessage, encryptMessage, unwrapKey } from "@legends/crypto";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { getBotFromRequest } from "@/lib/bot-auth";

async function getKeyData(keyId: string): Promise<Uint8Array> {
  const [row] = await db.select().from(encryptionKeys).where(eq(encryptionKeys.id, keyId)).limit(1);
  if (!row) throw new Error(`key ${keyId} not found`);
  return unwrapKey(row.wrappedKey);
}

export async function POST(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json() as { messageId: string; text: string };
  if (!body.messageId || !body.text?.trim()) {
    return NextResponse.json({ ok: false, error: "messageId and text required" }, { status: 400 });
  }

  const [msg] = await db.select().from(messages)
    .where(and(eq(messages.id, BigInt(body.messageId)), eq(messages.botId, bot.id), isNull(messages.deletedAt)))
    .limit(1);
  if (!msg) return NextResponse.json({ ok: false, error: "message not found or not owned by bot" }, { status: 404 });

  const key = await getKeyData(msg.keyId);
  const aad = new TextEncoder().encode(msg.topicId);
  // Re-encrypt with same key
  const { ciphertext, nonce } = encryptMessage(key, body.text.trim(), aad);
  const now = new Date();
  await db.update(messages).set({ contentCiphertext: ciphertext, contentNonce: nonce, editedAt: now }).where(eq(messages.id, BigInt(body.messageId)));

  await redis.publish(REDIS_CHANNELS.BOT_MESSAGE_EDIT, JSON.stringify({
    topicId: msg.topicId,
    message: { id: body.messageId, topicId: msg.topicId, text: body.text.trim(), editedAt: now },
  }));

  return NextResponse.json({ ok: true });
}
