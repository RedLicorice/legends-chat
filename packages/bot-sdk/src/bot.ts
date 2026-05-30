import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  CallbackQueryUpdate,
  DmMessageUpdate,
  MessageUpdate,
  NewMemberUpdate,
  SendDmMessageParams,
  SendMessageParams,
  Update,
} from "./types.js";
import { LegendsBotClient } from "./client.js";

// ─── Context objects ──────────────────────────────────────────────────────────

export class MessageContext {
  constructor(
    public readonly bot: LegendsBot,
    public readonly update: Update,
    public readonly message: MessageUpdate,
  ) {}

  get topicId(): string { return this.message.chat.id; }

  async reply(text: string, options?: Omit<SendMessageParams, "topicId" | "text">): Promise<{ messageId: string }> {
    return this.bot.api.sendMessage({ topicId: this.topicId, text, ...options });
  }

  async deleteThisMessage(): Promise<void> {
    return this.bot.api.deleteMessage({ messageId: this.message.message_id });
  }

  async editThisMessage(text: string): Promise<void> {
    return this.bot.api.editMessage({ messageId: this.message.message_id, text });
  }
}

export class NewMemberContext {
  constructor(
    public readonly bot: LegendsBot,
    public readonly update: Update,
    public readonly new_member: NewMemberUpdate,
  ) {}

  get topicId(): string { return this.new_member.topic_id; }

  async send(text: string, options?: Omit<SendMessageParams, "topicId" | "text">): Promise<{ messageId: string }> {
    return this.bot.api.sendMessage({ topicId: this.topicId, text, ...options });
  }
}

export class CallbackQueryContext {
  constructor(
    public readonly bot: LegendsBot,
    public readonly update: Update,
    public readonly callback_query: CallbackQueryUpdate,
  ) {}

  get topicId(): string { return this.callback_query.message.chat.id; }

  async answer(text?: string): Promise<void> {
    return this.bot.api.answerCallbackQuery({ callbackQueryId: this.callback_query.id, text });
  }

  async reply(text: string, options?: Omit<SendMessageParams, "topicId" | "text">): Promise<{ messageId: string }> {
    return this.bot.api.sendMessage({ topicId: this.topicId, text, ...options });
  }
}

export class DmMessageContext {
  constructor(
    public readonly bot: LegendsBot,
    public readonly update: Update,
    public readonly dm_message: DmMessageUpdate,
  ) {}

  get conversationId(): string { return this.dm_message.conversation_id; }

  async reply(text: string, options?: Omit<SendDmMessageParams, "conversationId" | "text">): Promise<{ messageId: string }> {
    return this.bot.api.sendDmMessage({ conversationId: this.conversationId, text, ...options });
  }
}

// ─── Handler types ────────────────────────────────────────────────────────────

type MsgHandler = (ctx: MessageContext) => Promise<void> | void;
type MemberHandler = (ctx: NewMemberContext) => Promise<void> | void;
type CallbackHandler = (ctx: CallbackQueryContext) => Promise<void> | void;
type DmMsgHandler = (ctx: DmMessageContext) => Promise<void> | void;
type ErrorHandler = (err: unknown, update: Update) => void;

// ─── Main bot class ───────────────────────────────────────────────────────────

export class LegendsBot {
  public readonly api: LegendsBotClient;

  private readonly _handlers = {
    message: [] as MsgHandler[],
    new_member: [] as MemberHandler[],
    callback_query: [] as CallbackHandler[],
    dm_message: [] as DmMsgHandler[],
  };

  private _onError: ErrorHandler = (err) => console.error("[bot] unhandled error:", err);
  private _running = false;

  constructor({ token, baseUrl }: { token: string; baseUrl?: string }) {
    this.api = new LegendsBotClient({ token, baseUrl });
  }

  on(event: "message", handler: MsgHandler): this;
  on(event: "new_member", handler: MemberHandler): this;
  on(event: "callback_query", handler: CallbackHandler): this;
  on(event: "dm_message", handler: DmMsgHandler): this;
  on(event: "message" | "new_member" | "callback_query" | "dm_message", handler: MsgHandler | MemberHandler | CallbackHandler | DmMsgHandler): this {
    (this._handlers[event] as (typeof handler)[]).push(handler);
    return this;
  }

  catch(handler: ErrorHandler): this {
    this._onError = handler;
    return this;
  }

  async handleUpdate(update: Update): Promise<void> {
    try {
      if (update.type === "message" && update.message) {
        const ctx = new MessageContext(this, update, update.message);
        for (const h of this._handlers.message) await h(ctx);
      } else if (update.type === "new_member" && update.new_member) {
        const ctx = new NewMemberContext(this, update, update.new_member);
        for (const h of this._handlers.new_member) await h(ctx);
      } else if (update.type === "callback_query" && update.callback_query) {
        const ctx = new CallbackQueryContext(this, update, update.callback_query);
        for (const h of this._handlers.callback_query) await h(ctx);
      } else if (update.type === "dm_message" && update.dm_message) {
        const ctx = new DmMessageContext(this, update, update.dm_message);
        for (const h of this._handlers.dm_message) await h(ctx);
      }
    } catch (err) {
      this._onError(err, update);
    }
  }

  // ── Webhook mode ─────────────────────────────────────────────────────────

  webhookCallback(path = "/webhook"): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    return async (req, res) => {
      if (req.url !== path || req.method !== "POST") {
        res.writeHead(404).end("Not found");
        return;
      }
      const body = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString()));
        req.on("error", reject);
      });
      res.writeHead(200).end("OK");
      try {
        await this.handleUpdate(JSON.parse(body) as Update);
      } catch (err) {
        this._onError(err, {} as Update);
      }
    };
  }

  async startWebhook({
    port,
    webhookUrl,
    path = "/webhook",
  }: {
    port: number;
    webhookUrl: string;
    path?: string;
  }): Promise<void> {
    await this.api.setWebhook(webhookUrl.replace(/\/$/, "") + path);
    const handler = this.webhookCallback(path);
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise<void>((resolve) => server.listen(port, resolve));
    console.log(`[bot] webhook server on :${port}${path} → ${webhookUrl}${path}`);
  }

  // ── Polling mode ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this._running = true;
    const info = await this.api.getMe().catch(() => null);
    console.log(`[bot] polling started${info ? ` (${info.name})` : ""}`);

    while (this._running) {
      try {
        const updates = await this.api.getUpdates();
        for (const u of updates) await this.handleUpdate(u);
        // getUpdates already long-polls server-side; only sleep if it returned empty
        if (updates.length === 0) await delay(500);
      } catch (err) {
        this._onError(err, {} as Update);
        await delay(5_000);
      }
    }
  }

  stop(): void {
    this._running = false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
