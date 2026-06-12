import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type {
  BotInfo,
  CallbackQueryUpdate,
  DmMessageUpdate,
  MessageUpdate,
  NewMemberUpdate,
  SendDmMessageParams,
  SendMessageParams,
  Update,
} from "./types.js";
import { LegendsBotClient } from "./client.js";
import { OlmStore } from "./crypto/olm-store.js";
import { BotOlmMachine } from "./crypto/olm-machine.js";
import { BotCryptoTransport } from "./transport-crypto.js";

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
  public readonly cryptoTransport: BotCryptoTransport;

  private readonly _handlers = {
    message: [] as MsgHandler[],
    new_member: [] as MemberHandler[],
    callback_query: [] as CallbackHandler[],
    dm_message: [] as DmMsgHandler[],
  };

  private _onError: ErrorHandler = (err) => console.error("[bot] unhandled error:", err);
  private _running = false;
  private _botInfo: BotInfo | null = null;
  private _crypto: BotOlmMachine | null = null;
  private _cryptoStore: OlmStore | null = null;
  private readonly _cryptoStorePath: string;

  constructor({
    token,
    baseUrl,
    cryptoStorePath,
  }: {
    token: string;
    baseUrl?: string;
    cryptoStorePath?: string;
  }) {
    this.api = new LegendsBotClient({ token, baseUrl });
    this.cryptoTransport = new BotCryptoTransport({ token, baseUrl });
    this._cryptoStorePath = cryptoStorePath ?? path.join(process.cwd(), "data", "olm-store.pickle");
  }

  /**
   * Resolve the bot's `getMe` response and, if `e2ee_state` is `pending` or
   * `ready`, instantiate the local Olm machine. On a fresh bootstrap (no
   * existing pickle), drains the initial `keys_upload` so the server records
   * the bot's identity + one-time keys before any sync traffic happens.
   *
   * Idempotent: re-invocation with an existing pickle reloads the same
   * identity from disk.
   */
  private async _loadBotInfo(): Promise<void> {
    const info = await this.api.getMe().catch(() => null);
    if (!info) return;
    this._botInfo = info;
    const state = info.e2ee_state ?? "disabled";
    if (state === "disabled") {
      this._crypto = null;
      return;
    }
    await this._initCrypto(info);
  }

  /**
   * Bootstrap or reload the Olm machine for an E2EE-enabled bot. Splits the
   * "first run" path (drain `keys_upload`, persist) from the warm-start path
   * (existing pickle is reloaded as-is — the sync loop will surface any new
   * outgoing requests on its first iteration).
   */
  private async _initCrypto(info: BotInfo): Promise<void> {
    this._cryptoStore = new OlmStore(this._cryptoStorePath);
    const hadPickle = await this._cryptoStore.exists();
    this._crypto = await BotOlmMachine.create({ botId: info.id, store: this._cryptoStore });
    if (!hadPickle) {
      const reqs = await this._crypto.outgoingRequests();
      for (const r of reqs) {
        if (r.type === "keys_upload") {
          const resp = await this.cryptoTransport.keysUpload(JSON.parse(r.body));
          await this._crypto.markRequestAsSent(r.id, JSON.stringify(resp));
        }
      }
      await this._crypto.persist();
    }
  }

  /**
   * Test hook: drive `_loadBotInfo` without spinning up the polling loop.
   * Production callers go through {@link start}.
   */
  public async loadBotInfoForTest(): Promise<void> {
    await this._loadBotInfo();
  }

  /** Test hook: peek at the Olm machine (null when E2EE is disabled). */
  public cryptoForTest(): BotOlmMachine | null {
    return this._crypto;
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
        const msg = await this._decryptIncomingMessage(update.message);
        const ctx = new MessageContext(this, update, msg);
        for (const h of this._handlers.message) await h(ctx);
      } else if (update.type === "new_member" && update.new_member) {
        const ctx = new NewMemberContext(this, update, update.new_member);
        for (const h of this._handlers.new_member) await h(ctx);
      } else if (update.type === "callback_query" && update.callback_query) {
        const ctx = new CallbackQueryContext(this, update, update.callback_query);
        for (const h of this._handlers.callback_query) await h(ctx);
      } else if (update.type === "dm_message" && update.dm_message) {
        const dm = await this._decryptIncomingDm(update.dm_message);
        const ctx = new DmMessageContext(this, update, dm);
        for (const h of this._handlers.dm_message) await h(ctx);
      }
    } catch (err) {
      this._onError(err, update);
    }
  }

  /**
   * Pre-process step: if the incoming topic message has a `ciphertext` field,
   * decrypt it through the Olm machine and surface the plaintext to handlers
   * as `text`. Plaintext messages pass through unchanged. A decrypt failure
   * propagates and is caught by {@link handleUpdate}, surfacing through
   * `_onError` per spec §11.
   */
  private async _decryptIncomingMessage(m: MessageUpdate): Promise<MessageUpdate> {
    if (!m.ciphertext || !m.e2ee_room_id || !this._crypto) return m;
    const sender = m.sender_matrix_id ?? "";
    const plaintext = await this._crypto.decryptRoomMessage(m.e2ee_room_id, {
      ciphertext: m.ciphertext,
      sender,
    });
    return { ...m, text: plaintext };
  }

  /** DM-flavour of {@link _decryptIncomingMessage}. */
  private async _decryptIncomingDm(d: DmMessageUpdate): Promise<DmMessageUpdate> {
    if (!d.ciphertext || !d.e2ee_room_id || !this._crypto) return d;
    const sender = d.sender_matrix_id ?? "";
    const plaintext = await this._crypto.decryptRoomMessage(d.e2ee_room_id, {
      ciphertext: d.ciphertext,
      sender,
    });
    return { ...d, text: plaintext };
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
    path: webhookPath = "/webhook",
  }: {
    port: number;
    webhookUrl: string;
    path?: string;
  }): Promise<void> {
    await this._loadBotInfo();
    await this.api.setWebhook(webhookUrl.replace(/\/$/, "") + webhookPath);
    const handler = this.webhookCallback(webhookPath);
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise<void>((resolve) => server.listen(port, resolve));
    console.log(`[bot] webhook server on :${port}${webhookPath} → ${webhookUrl}${webhookPath}`);
  }

  // ── Polling mode ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this._running = true;
    await this._loadBotInfo();
    console.log(`[bot] polling started${this._botInfo ? ` (${this._botInfo.name})` : ""}`);

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
