import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LegendsBot } from "../src/bot.js";
import { OlmStore } from "../src/crypto/olm-store.js";
import { BotOlmMachine, type OutgoingRequest } from "../src/crypto/olm-machine.js";

/**
 * Drives `handleUpdate` through the new E2EE pre-process step (Task 21).
 *
 * The setup mirrors `test/crypto/olm-machine.test.ts`'s round-trip helper: we
 * stand up two `BotOlmMachine`s in-process — one as the bot (loaded inside
 * `LegendsBot`), one as the test's "user" peer — broker their crypto-control
 * traffic through a local {@link PeerDirectory}, then encrypt a payload as the
 * user and feed it into the bot via `handleUpdate`. The handler should
 * receive the decrypted plaintext as `dm_message.text`.
 */
describe("LegendsBot — incoming decrypt", () => {
  let dir: string;
  const fetchSpy = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bot-incoming-"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    fetchSpy.mockReset();
    await resetIdb();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function mockGetMe(state: "pending" | "ready", directory?: PeerDirectory): void {
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/bot/v1/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: "bot-a",
              name: "A",
              avatarUrl: null,
              webhookUrl: null,
              e2ee_state: state,
              e2ee_device_id: "DEV-A",
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/bot/v1/crypto/keys/upload")) {
        if (directory && typeof init?.body === "string") {
          const body = JSON.parse(init.body) as UploadBody & { device_keys?: { user_id?: string; device_id?: string } };
          const matrixId = (body.device_keys as { user_id?: string } | undefined)?.user_id ?? "@bot.bot-a:legends.local";
          const deviceId = (body.device_keys as { device_id?: string } | undefined)?.device_id ?? "DEV-A";
          directory.registerUpload(matrixId, deviceId, body);
        }
        return new Response(
          JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });
  }

  it("decrypts a DM envelope and passes plaintext to the handler", async () => {
    const directory = new PeerDirectory();
    mockGetMe("ready", directory);
    const bot = new LegendsBot({
      token: "tok",
      baseUrl: "https://chat.test",
      cryptoStorePath: path.join(dir, "bot.pickle"),
    });
    await bot.loadBotInfoForTest();
    const botMachine = bot.cryptoForTest()!;

    const user = await BotOlmMachine.create({
      botId: "user-a",
      store: new OlmStore(path.join(dir, "user.pickle")),
      matrixId: "@user-a:legends.local",
    });

    const botId = botMachine.getMatrixId();
    const userId = user.getMatrixId();
    const roomId = "!conv1:legends.local";

    // The bot uploaded once via _initCrypto's fetch path; the mock above
    // registered that upload with the directory so the user-side keys_query
    // and keys_claim can later answer for the bot.
    await drainRequests(botMachine, directory);
    await drainRequests(user, directory);

    await user.updateTrackedUsers([botId]);
    await botMachine.updateTrackedUsers([userId]);
    await drainRequests(user, directory);
    await drainRequests(botMachine, directory);

    // User establishes an Olm session with the bot, then shares a room key.
    const claim = await user.getMissingSessions([botId]);
    if (claim) {
      await user.markRequestAsSent(claim.id, directory.respondToClaim(claim.body));
    }
    const shareReqs = await user.shareRoomKey(roomId, [botId]);
    expect(shareReqs.length).toBeGreaterThan(0);
    for (const req of shareReqs) {
      await botMachine.receiveSyncChanges({
        toDevice: toDeviceEventsJson(req, userId),
        otkCounts: {},
      });
      await user.markRequestAsSent(req.id, "{}");
    }

    const { ciphertext } = await user.encryptForRoom(roomId, "hello bot", "m.room.message");

    let received: string | null = null;
    bot.on("dm_message", (ctx) => {
      received = ctx.dm_message.text;
    });
    await bot.handleUpdate({
      update_id: "u1",
      type: "dm_message",
      dm_message: {
        message_id: "m1",
        conversation_id: "conv1",
        from: { id: "user-a", display_name: "U" },
        text: "",
        ciphertext,
        e2ee_room_id: roomId,
        sender_matrix_id: userId,
        date: 0,
      },
    });
    expect(received).toBe("hello bot");
  });

  it("calls _onError and skips the handler when ciphertext fails to decrypt", async () => {
    mockGetMe("ready");
    const bot = new LegendsBot({
      token: "tok",
      baseUrl: "https://chat.test",
      cryptoStorePath: path.join(dir, "bot.pickle"),
    });
    await bot.loadBotInfoForTest();

    const handlerCalls: string[] = [];
    bot.on("dm_message", (ctx) => {
      handlerCalls.push(ctx.dm_message.text);
    });
    const errors: unknown[] = [];
    bot.catch((err) => {
      errors.push(err);
    });

    await bot.handleUpdate({
      update_id: "u2",
      type: "dm_message",
      dm_message: {
        message_id: "m2",
        conversation_id: "conv1",
        from: { id: "user-a", display_name: "U" },
        text: "",
        ciphertext:
          '{"algorithm":"garbage","ciphertext":"garbage","sender_key":"x","session_id":"y","device_id":"z"}',
        e2ee_room_id: "!conv1:legends.local",
        sender_matrix_id: "@user-a:legends.local",
        date: 0,
      },
    });
    expect(handlerCalls).toEqual([]);
    expect(errors.length).toBe(1);
  });
});

// ── Test helpers (lifted from test/crypto/olm-machine.test.ts) ─────────────

class PeerDirectory {
  private readonly uploads = new Map<string, UploadBody>();

  registerUpload(matrixId: string, deviceId: string, body: UploadBody): void {
    const existing = this.uploads.get(matrixId);
    const otkUnion = { ...(existing?.one_time_keys ?? {}), ...(body.one_time_keys ?? {}) };
    this.uploads.set(matrixId, {
      device_id: deviceId,
      device_keys: body.device_keys ?? existing?.device_keys,
      one_time_keys: otkUnion,
      fallback_keys: body.fallback_keys ?? existing?.fallback_keys,
    });
  }

  respondToQuery(bodyJson: string): string {
    const body = JSON.parse(bodyJson) as { device_keys: Record<string, unknown[]> };
    const response: QueryResponse = {
      device_keys: {},
      master_keys: {},
      self_signing_keys: {},
      user_signing_keys: {},
    };
    for (const userId of Object.keys(body.device_keys ?? {})) {
      const upload = this.uploads.get(userId);
      if (!upload || !upload.device_keys) continue;
      response.device_keys[userId] = { [upload.device_id]: upload.device_keys };
    }
    return JSON.stringify(response);
  }

  respondToClaim(bodyJson: string): string {
    const body = JSON.parse(bodyJson) as {
      one_time_keys: Record<string, Record<string, string>>;
    };
    const response: ClaimResponse = { one_time_keys: {} };
    for (const userId of Object.keys(body.one_time_keys ?? {})) {
      const upload = this.uploads.get(userId);
      if (!upload) continue;
      response.one_time_keys[userId] = {};
      for (const deviceId of Object.keys(body.one_time_keys[userId] ?? {})) {
        const otks = upload.one_time_keys ?? {};
        const otkKey = Object.keys(otks).find((k) => k.startsWith("signed_curve25519:"));
        if (!otkKey) continue;
        response.one_time_keys[userId][deviceId] = { [otkKey]: otks[otkKey]! };
        delete otks[otkKey];
      }
    }
    return JSON.stringify(response);
  }
}

interface UploadBody {
  device_id: string;
  device_keys?: unknown;
  one_time_keys?: Record<string, unknown>;
  fallback_keys?: Record<string, unknown>;
}

interface QueryResponse {
  device_keys: Record<string, Record<string, unknown>>;
  master_keys: Record<string, unknown>;
  self_signing_keys: Record<string, unknown>;
  user_signing_keys: Record<string, unknown>;
}

interface ClaimResponse {
  one_time_keys: Record<string, Record<string, Record<string, unknown>>>;
}

async function drainRequests(machine: BotOlmMachine, directory: PeerDirectory): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const reqs = await machine.outgoingRequests();
    if (reqs.length === 0) return;
    for (const r of reqs) {
      const response = synthesizeResponse(r, machine, directory);
      await machine.markRequestAsSent(r.id, response);
    }
  }
}

function synthesizeResponse(
  r: OutgoingRequest,
  machine: BotOlmMachine,
  directory: PeerDirectory,
): string {
  switch (r.type) {
    case "keys_upload": {
      const body = JSON.parse(r.body) as UploadBody;
      directory.registerUpload(machine.getMatrixId(), machine.getDeviceId(), body);
      return JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } });
    }
    case "keys_query":
      return directory.respondToQuery(r.body);
    case "keys_claim":
      return directory.respondToClaim(r.body);
    default:
      return "{}";
  }
}

function toDeviceEventsJson(req: OutgoingRequest, sender: string): string {
  if (!req.event_type) throw new Error("toDeviceEventsJson: request has no event_type");
  const body = JSON.parse(req.body) as {
    messages: Record<string, Record<string, unknown>>;
  };
  const events: Array<{ type: string; sender: string; content: unknown }> = [];
  for (const userMessages of Object.values(body.messages ?? {})) {
    for (const content of Object.values(userMessages ?? {})) {
      events.push({ type: req.event_type, sender, content });
    }
  }
  return JSON.stringify(events);
}

async function resetIdb(): Promise<void> {
  const mod = await import("fake-indexeddb");
  const FactoryCtor = (mod as { IDBFactory: { new (): IDBFactory } }).IDBFactory;
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FactoryCtor();
}
