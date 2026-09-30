import { messages } from "./schema";
import { db } from "./client";
import { currentDataKey } from "./data-keys";
import { encryptMessage } from "@legends/crypto";

export async function insertSystemMessage(topicId: string, text: string): Promise<string> {
  // cr-l12: key selection now lives in ./data-keys (locked create path); this
  // file used to carry its own copy of the read-then-insert race.
  const key = await currentDataKey("messages");
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
