import type { BotInfo, SendMessageParams, Update } from "./types.js";

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
}
