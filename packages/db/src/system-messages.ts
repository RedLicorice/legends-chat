import { desc, eq } from "drizzle-orm";
import { encryptionKeys, messages } from "./schema";
import { db } from "./client";
import {
  decryptMessage,
  encryptMessage,
  generateDataKey,
  unwrapKey,
  wrapKey,
} from "@legends/crypto";

let cachedKey: { id: string; data: Uint8Array } | null = null;

async function currentDataKey(): Promise<{ id: string; data: Uint8Array }> {
  if (cachedKey) return cachedKey;
  const rows = await db
    .select()
    .from(encryptionKeys)
    .where(eq(encryptionKeys.purpose, "messages"))
    .orderBy(desc(encryptionKeys.createdAt))
    .limit(1);
  if (rows[0]) {
    cachedKey = { id: rows[0].id, data: unwrapKey(rows[0].wrappedKey) };
    return cachedKey;
  }
  const data = generateDataKey();
  const { wrapped } = wrapKey(data);
  const [inserted] = await db
    .insert(encryptionKeys)
    .values({ purpose: "messages", wrappedKey: wrapped })
    .returning();
  cachedKey = { id: inserted!.id, data };
  return cachedKey;
}

export async function insertSystemMessage(topicId: string, text: string): Promise<string> {
  const key = await currentDataKey();
  const aad = new TextEncoder().encode(topicId);
  const { ciphertext, nonce } = encryptMessage(key.data, text, aad);
  const [row] = await db
    .insert(messages)
    .values({
      topicId,
      senderUserId: null,
      botId: null,
      contentCiphertext: ciphertext,
      contentNonce: nonce,
      keyId: key.id,
    })
    .returning({ id: messages.id });
  return row!.id.toString();
}
