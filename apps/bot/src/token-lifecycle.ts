import type { Api } from "grammy";
import { REDIS_CHANNELS } from "@legends/shared";
import { isTokenConsumed, listPendingTokensWithTelegramRefs } from "./login";
import { subClient } from "./redis";

const DELETE_AFTER_MS = 3 * 60 * 1000;

async function editAndScheduleDelete(
  api: Api,
  chatId: bigint,
  messageId: number,
  newText: string,
): Promise<void> {
  try {
    await api.editMessageText(Number(chatId), messageId, newText, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    });
  } catch (err) {
    // Message might already be gone (user deleted, too old, etc.) — non-fatal.
    console.warn("[lifecycle] editMessageText failed", (err as Error).message);
    return;
  }
  setTimeout(() => {
    api
      .deleteMessage(Number(chatId), messageId)
      .catch((err) => console.warn("[lifecycle] deleteMessage failed", (err as Error).message));
  }, DELETE_AFTER_MS);
}

/**
 * When a login token is issued we remember to check, at its expiry time,
 * whether it was ever consumed. If not, the bot's own message is edited
 * to "Token expired" and deleted a few minutes later.
 */
export function scheduleExpiryCheck(
  api: Api,
  tokenId: string,
  chatId: bigint,
  messageId: number,
  expiresAt: Date,
): void {
  const msUntilExpiry = expiresAt.getTime() - Date.now();
  if (msUntilExpiry <= 0) return;
  setTimeout(async () => {
    try {
      if (await isTokenConsumed(tokenId)) return;
      await editAndScheduleDelete(api, chatId, messageId, "⌛ <b>Token expired.</b>");
    } catch (err) {
      console.warn("[lifecycle] expiry check failed", (err as Error).message);
    }
  }, msUntilExpiry);
}

/**
 * On process start, reschedule expiry checks for every still-active token
 * the database has Telegram refs for. Tokens minted before this session
 * won't lose their "Token expired" lifecycle when the bot restarts.
 */
export async function rescheduleOnStartup(api: Api): Promise<void> {
  const pending = await listPendingTokensWithTelegramRefs();
  for (const p of pending) {
    scheduleExpiryCheck(api, p.id, p.chatId, p.messageId, p.expiresAt);
  }
  if (pending.length > 0) {
    console.log(`[lifecycle] rescheduled ${pending.length} pending token expiries`);
  }
}

/**
 * Subscribes to the Redis channel the web app publishes to when a
 * login token gets consumed. On a hit, edits the original Telegram
 * message and schedules its deletion.
 */
export function subscribeToConsumption(api: Api): void {
  subClient.subscribe(REDIS_CHANNELS.LOGIN_TOKEN_CONSUMED, (err) => {
    if (err) console.error("[lifecycle] redis subscribe failed", err);
  });
  subClient.on("message", (channel, payload) => {
    if (channel !== REDIS_CHANNELS.LOGIN_TOKEN_CONSUMED) return;
    try {
      const parsed = JSON.parse(payload) as {
        chatId?: string | number;
        messageId?: number;
      };
      if (!parsed.chatId || !parsed.messageId) return;
      const chatId = BigInt(parsed.chatId);
      void editAndScheduleDelete(api, chatId, parsed.messageId, "✅ <b>Token used!</b>");
    } catch (err) {
      console.warn("[lifecycle] pubsub parse failed", (err as Error).message);
    }
  });
}
