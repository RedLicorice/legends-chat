import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LegendsBot, DmMessageContext } from "../src/bot.js";
import { BotOlmMachine, type OutgoingRequest } from "../src/crypto/olm-machine.js";
import { OlmStore } from "../src/crypto/olm-store.js";

/**
 * Drives `DmMessageContext.reply()` through the new E2EE outgoing path
 * (Task 22). The flow under test:
 *
 *   1. Hit `/api/bot/v1/crypto/rooms/<roomId>` for the member list.
 *   2. (Indirectly via `getMissingSessions`) hit `/keys/claim` for Olm sessions.
 *   3. Drive Megolm `shareRoomKey` to-device requests via `sendToDevice`.
 *   4. Encrypt the plaintext + POST `/api/bot/v1/sendDmMessage`.
 *
 * The fetch mock answers each leg. We don't need a real peer machine —
 * the test only verifies that the SDK walks the sequence and that the
 * outbound ciphertext is non-empty.
 */
describe("LegendsBot — outgoing encrypt", () => {
  let dir: string;
  const fetchSpy = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bot-out-"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    fetchSpy.mockReset();
    await resetIdb();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("ctx.reply on an E2EE DM walks the full key-share + encrypt + sendDmCiphertext sequence", { timeout: 20_000 }, async () => {
    const calls: Array<{ url: string; method: string }> = [];
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
      if (url.endsWith("/api/bot/v1/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: "bot-a",
              name: "A",
              avatarUrl: null,
              webhookUrl: null,
              e2ee_state: "ready",
              e2ee_device_id: "DEV-A",
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/bot/v1/crypto/keys/upload")) {
        return new Response(
          JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }),
          { status: 200 },
        );
      }
      if (url.includes("/api/bot/v1/crypto/rooms/")) {
        return new Response(
          JSON.stringify({ members: [{ matrix_id: "@user-a:legends.local", devices: ["DEV-U"] }] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/bot/v1/crypto/keys/query")) {
        return new Response(JSON.stringify({ device_keys: {} }), { status: 200 });
      }
      if (url.endsWith("/api/bot/v1/crypto/keys/claim")) {
        return new Response(JSON.stringify({ one_time_keys: {} }), { status: 200 });
      }
      if (url.includes("/api/bot/v1/crypto/sendToDevice/")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.endsWith("/api/bot/v1/sendDmMessage")) {
        return new Response(
          JSON.stringify({ ok: true, result: { messageId: "m-out-1" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    const bot = new LegendsBot({
      token: "tok",
      baseUrl: "https://chat.test",
      cryptoStorePath: path.join(dir, "bot.pickle"),
    });
    await bot.loadBotInfoForTest();

    const ctx = new DmMessageContext(
      bot,
      { update_id: "u", type: "dm_message" },
      {
        message_id: "m1",
        conversation_id: "conv1",
        from: { id: "user-a", display_name: "U" },
        text: "hi",
        ciphertext: undefined,
        e2ee_room_id: "!conv1:legends.local",
        sender_matrix_id: "@user-a:legends.local",
        date: 0,
      },
    );

    const out = await ctx.reply("hello back");
    expect(out.messageId).toBe("m-out-1");

    const paths = calls.map((c) => c.url);
    expect(paths.some((p) => p.includes("/crypto/rooms/"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/api/bot/v1/sendDmMessage"))).toBe(true);

    // Body shape: { conversationId, ciphertext } — R1.
    const sendCall = fetchSpy.mock.calls.find(
      (c) => (c[0] as string).endsWith("/api/bot/v1/sendDmMessage"),
    )!;
    const body = JSON.parse((sendCall[1] as RequestInit).body as string) as {
      conversationId: string;
      ciphertext: string;
    };
    expect(body.conversationId).toBe("conv1");
    expect(body.ciphertext.length).toBeGreaterThan(0);
  });

  it(
    "first reply (no pre-tracked user) drives keys_query + keys_claim + share so the recipient can decrypt",
    async () => {
      // This test exercises the bug repro: the bot has never tracked the
      // recipient user, so on the first reply the wasm has no device list
      // for that user. Without an in-flight `updateTrackedUsers` +
      // `keys_query` drain, `shareRoomKey` emits `m.room_key.withheld`
      // and the user can't decrypt.
      //
      // The fixture wires a real fixture user machine on the other end of
      // the fetch mock so that the assertion "user decrypts the bot's
      // ciphertext" is meaningful end-to-end — not just "fetch was called".
      const userDir = path.join(dir, "user");
      const user = await BotOlmMachine.create({
        botId: "user-b",
        store: new OlmStore(path.join(userDir, "user.pickle")),
        matrixId: "@user-b:legends.local",
      });
      const directory = new PeerDirectory();
      // Pre-populate the directory with the user's device + OTKs so the
      // server can answer `/keys/query` and `/keys/claim` for them when
      // the bot asks. (No bot uploads yet — we register the bot's
      // identity when its keys_upload arrives below.)
      await drainRequestsToDirectory(user, directory);

      // Captured to-device payloads that the bot dispatches; we feed
      // them into the user machine after the encrypt step so it has the
      // megolm session before we try to decrypt.
      const toDeviceForUser: Array<{ type: string; sender: string; content: unknown }> = [];
      let captured: { conversationId: string; ciphertext: string } | null = null;

      fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/api/bot/v1/getMe")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: "bot-b",
                name: "B",
                avatarUrl: null,
                webhookUrl: null,
                e2ee_state: "ready",
                e2ee_device_id: "DEV-B",
              },
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/bot/v1/crypto/keys/upload")) {
          const body = JSON.parse((init?.body as string) ?? "{}") as UploadBody;
          // The bot's matrixId is fixed by BotOlmMachine.create.
          directory.registerUpload("@bot.bot-b:legends.local", "DEV-B", body);
          return new Response(
            JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }),
            { status: 200 },
          );
        }
        if (url.includes("/api/bot/v1/crypto/rooms/")) {
          return new Response(
            JSON.stringify({ members: [{ matrix_id: user.getMatrixId(), devices: [user.getDeviceId()] }] }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/bot/v1/crypto/keys/query")) {
          return new Response(directory.respondToQuery((init?.body as string) ?? "{}"), { status: 200 });
        }
        if (url.endsWith("/api/bot/v1/crypto/keys/claim")) {
          return new Response(directory.respondToClaim((init?.body as string) ?? "{}"), { status: 200 });
        }
        if (url.includes("/api/bot/v1/crypto/sendToDevice/")) {
          const seg = url.split("/api/bot/v1/crypto/sendToDevice/")[1] ?? "";
          const eventType = decodeURIComponent(seg.split("/")[0] ?? "");
          const body = JSON.parse((init?.body as string) ?? "{}") as {
            messages: Record<string, Record<string, unknown>>;
          };
          for (const [userId, userMsgs] of Object.entries(body.messages ?? {})) {
            if (userId !== user.getMatrixId()) continue;
            for (const content of Object.values(userMsgs ?? {})) {
              toDeviceForUser.push({ type: eventType, sender: "@bot.bot-b:legends.local", content });
            }
          }
          return new Response(JSON.stringify({}), { status: 200 });
        }
        if (url.endsWith("/api/bot/v1/sendDmMessage")) {
          captured = JSON.parse((init?.body as string) ?? "{}") as {
            conversationId: string;
            ciphertext: string;
          };
          return new Response(
            JSON.stringify({ ok: true, result: { messageId: "m-out-2" } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      });

      const bot = new LegendsBot({
        token: "tok",
        baseUrl: "https://chat.test",
        cryptoStorePath: path.join(dir, "bot.pickle"),
      });
      await bot.loadBotInfoForTest();

      // The bug repro: NO pre-call to updateTrackedUsers on the bot side.
      // Production hits this path because the bot has never seen this
      // user before its first reply.

      const ctx = new DmMessageContext(
        bot,
        { update_id: "u", type: "dm_message" },
        {
          message_id: "m1",
          conversation_id: "conv-b",
          from: { id: "user-b", display_name: "U" },
          text: "hi",
          ciphertext: undefined,
          e2ee_room_id: "!conv-b:legends.local",
          sender_matrix_id: user.getMatrixId(),
          date: 0,
        },
      );

      const out = await ctx.reply("hello from bot");
      expect(out.messageId).toBe("m-out-2");
      expect(captured).not.toBeNull();

      // Hand the to-device payloads (m.room_key) to the user machine so
      // it has the megolm session, then decrypt the captured ciphertext.
      expect(toDeviceForUser.length).toBeGreaterThan(0);
      await user.receiveSyncChanges({
        toDevice: JSON.stringify(toDeviceForUser),
        otkCounts: {},
      });

      const captured2 = captured as unknown as { conversationId: string; ciphertext: string };
      const plaintext = await user.decryptRoomMessage("!conv-b:legends.local", {
        ciphertext: captured2.ciphertext,
        sender: "@bot.bot-b:legends.local",
      });
      expect(plaintext).toBe("hello from bot");
    },
    20_000,
  );

  it("ctx.reply on a non-E2EE DM falls back to sendMessage (plaintext)", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/bot/v1/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: "bot-a",
              name: "A",
              avatarUrl: null,
              webhookUrl: null,
              e2ee_state: "disabled",
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/bot/v1/sendMessage")) {
        return new Response(
          JSON.stringify({ ok: true, result: { messageId: "m-plain" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });

    const bot = new LegendsBot({
      token: "tok",
      baseUrl: "https://chat.test",
      cryptoStorePath: path.join(dir, "bot.pickle"),
    });
    await bot.loadBotInfoForTest();

    const ctx = new DmMessageContext(
      bot,
      { update_id: "u", type: "dm_message" },
      {
        message_id: "m1",
        conversation_id: "conv1",
        from: { id: "user-a", display_name: "U" },
        text: "hi",
        date: 0,
      },
    );

    const out = await ctx.reply("hello back");
    expect(out.messageId).toBe("m-plain");
  });
});

async function resetIdb(): Promise<void> {
  const mod = await import("fake-indexeddb");
  const FactoryCtor = (mod as { IDBFactory: { new (): IDBFactory } }).IDBFactory;
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FactoryCtor();
}

// ── peer fixture (subset of ciphertext-wire.test.ts) ──────────────────────

class PeerDirectory {
  private readonly uploads = new Map<string, UploadBody & { device_id: string }>();

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

async function drainRequestsToDirectory(
  machine: BotOlmMachine,
  directory: PeerDirectory,
): Promise<void> {
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
