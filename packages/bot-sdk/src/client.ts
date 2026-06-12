import type { BotInfo, SendDmMessageParams, SendMessageParams, Update } from "./types.js";

export class LegendsBotClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor({ token, baseUrl = "" }: { token: string; baseUrl?: string }) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async call<T>(method: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/bot/v1/${method}`;
    const isGet = body === undefined;
    const res = await fetch(url, {
      method: isGet ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(isGet ? {} : { "content-type": "application/json" }),
      },
      body: isGet ? undefined : JSON.stringify(body),
    });
    const data = await res.json() as { ok: boolean; result?: T; error?: string };
    if (!data.ok) throw new Error(data.error ?? `Bot API error ${res.status} on ${method}`);
    return data.result as T;
  }

  async getMe(): Promise<BotInfo> {
    return this.call<BotInfo>("getMe");
  }

  async sendMessage(params: SendMessageParams): Promise<{ messageId: string }> {
    return this.call<{ messageId: string }>("sendMessage", params);
  }

  async sendDmMessage(params: SendDmMessageParams): Promise<{ messageId: string }> {
    return this.call<{ messageId: string }>("sendMessage", params);
  }

  async editMessage(params: { messageId: string; text: string }): Promise<void> {
    return this.call<void>("editMessage", params);
  }

  async deleteMessage(params: { messageId: string }): Promise<void> {
    return this.call<void>("deleteMessage", params);
  }

  async answerCallbackQuery(params: { callbackQueryId: string; text?: string }): Promise<void> {
    return this.call<void>("answerCallbackQuery", params);
  }

  async setWebhook(url: string | null): Promise<void> {
    return this.call<void>("setWebhook", { url });
  }

  async getUpdates(): Promise<Update[]> {
    return this.call<Update[]>("getUpdates");
  }

  /**
   * Send an E2EE DM ciphertext envelope. Wraps the RPC route
   * `POST /api/bot/v1/sendDmMessage` (per INDEX R1) — the same server
   * handler accepts `{conversationId, text}` for plaintext and
   * `{conversationId, ciphertext}` for E2EE. The SDK exposes the two
   * shapes as separate methods so callers don't have to construct the
   * union manually.
   */
  async sendDmCiphertext(params: {
    conversationId: string;
    ciphertext: string;
    replyToMessageId?: string;
  }): Promise<{ messageId: string }> {
    return this.call<{ messageId: string }>("sendDmMessage", params);
  }

  /**
   * Send an E2EE topic ciphertext envelope. Per INDEX R2 the existing
   * `POST /api/bot/v1/sendMessage` route is extended to accept
   * `ciphertext` alongside `text`; this method packages the ciphertext
   * shape.
   */
  async sendTopicCiphertext(params: {
    topicId: string;
    ciphertext: string;
    replyToMessageId?: string;
  }): Promise<{ messageId: string }> {
    return this.call<{ messageId: string }>("sendMessage", params);
  }
}
