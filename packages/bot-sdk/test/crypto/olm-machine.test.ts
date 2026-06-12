import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OlmStore } from "../../src/crypto/olm-store.js";
import { BotOlmMachine, type OutgoingRequest } from "../../src/crypto/olm-machine.js";

/**
 * `BotOlmMachine` is the bot SDK's wrapper around `@matrix-org/matrix-sdk-crypto-wasm`.
 * Tests run in Node with `fake-indexeddb/auto` providing the IDB backend; the
 * wrapper uses {@link OlmStore} for an on-disk JSON snapshot.
 *
 * Each test gets a fresh tmp dir (so {@link OlmStore} files don't bleed) and a
 * fresh `IDBFactory` (so the wasm machines from one test don't see databases
 * from another — see `resetIdb` below).
 */
describe("BotOlmMachine", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "olm-machine-"));
    await resetIdb();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("bootstraps with an empty store and exposes identity keys", async () => {
    const store = new OlmStore(path.join(dir, "store.pickle"));
    const m = await BotOlmMachine.create({ botId: "bot-a", store });
    const ids = m.getIdentityKeys();
    // Olm identity keys are unpadded base64 (43 chars for 32-byte keys).
    expect(ids.ed25519).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(ids.curve25519).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(m.getDeviceId()).toMatch(/^[A-Z0-9]{10}$/);
    expect(m.getMatrixId()).toBe("@bot.bot-a:legends.local");
  });

  it("outgoingRequests includes a keys_upload after bootstrap", async () => {
    const store = new OlmStore(path.join(dir, "store.pickle"));
    const m = await BotOlmMachine.create({ botId: "bot-a", store });
    const reqs = await m.outgoingRequests();
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.some((r) => r.type === "keys_upload")).toBe(true);
  });

  it("persist() then create() with existing pickle reuses the same identity", async () => {
    const storePath = path.join(dir, "store.pickle");
    const store1 = new OlmStore(storePath);
    const m1 = await BotOlmMachine.create({ botId: "bot-a", store: store1 });
    const ed1 = m1.getIdentityKeys().ed25519;
    const dev1 = m1.getDeviceId();
    const matrix1 = m1.getMatrixId();
    await m1.persist();

    // Reset the in-memory IDB factory so the second instance is forced to
    // restore from disk rather than re-using the same DB the first instance
    // bootstrapped into.
    await resetIdb();

    const store2 = new OlmStore(storePath);
    const m2 = await BotOlmMachine.create({ botId: "bot-a", store: store2 });
    expect(m2.getIdentityKeys().ed25519).toBe(ed1);
    expect(m2.getDeviceId()).toBe(dev1);
    expect(m2.getMatrixId()).toBe(matrix1);
  });

  it("round-trips an encrypted room message between bot and user machines", async () => {
    const bot = await BotOlmMachine.create({
      botId: "bot-a",
      store: new OlmStore(path.join(dir, "bot.pickle")),
    });
    const user = await BotOlmMachine.create({
      botId: "user-a",
      store: new OlmStore(path.join(dir, "user.pickle")),
      matrixId: "@user-a:legends.local",
    });

    const botId = bot.getMatrixId();
    const userId = user.getMatrixId();
    const roomId = "!room1:legends.local";

    // Simulate the server-side dance: both machines upload keys; each peer's
    // upload body is then fed back to the other side as a `keys_query` /
    // `keys_claim` response. Once both sides know each other's devices the bot
    // can claim a user OTK, set up an Olm session, and share a Megolm room
    // key via to-device delivery.
    const directory = new PeerDirectory();
    await drainRequests(bot, directory);
    await drainRequests(user, directory);

    await bot.updateTrackedUsers([userId]);
    await user.updateTrackedUsers([botId]);
    await drainRequests(bot, directory);
    await drainRequests(user, directory);

    // Bot needs an Olm session with the user before megolm key-sharing works.
    const claim = await bot.getMissingSessions([userId]);
    if (claim) {
      await bot.markRequestAsSent(claim.id, directory.respondToClaim(claim.body));
    }

    // Share the room key, then deliver each to-device envelope directly to the
    // user's machine.
    const shareReqs = await bot.shareRoomKey(roomId, [userId]);
    expect(shareReqs.length).toBeGreaterThan(0);
    for (const req of shareReqs) {
      await user.receiveSyncChanges({
        toDevice: toDeviceEventsJson(req, botId),
        otkCounts: {},
      });
      await bot.markRequestAsSent(req.id, "{}");
    }

    const { ciphertext } = await bot.encryptForRoom(roomId, "hello user", "m.room.message");
    expect(ciphertext.length).toBeGreaterThan(0);

    const plaintext = await user.decryptRoomMessage(roomId, { ciphertext, sender: botId });
    expect(plaintext).toBe("hello user");
  });
});

// ── Test helpers ────────────────────────────────────────────────────────────

/**
 * Tracks each peer's most recent `keys_upload` body so that subsequent
 * `keys_query` / `keys_claim` requests can be answered with realistic
 * server responses. Mirrors what `apps/web/app/api/bot/v1/crypto/*` will do.
 */
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
        // Consume the OTK so a subsequent claim against the same body
        // doesn't reuse it — matches real server behavior.
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

/**
 * Drain the machine's outgoing request queue until it stops producing new
 * work. Each request gets a plausible server response synthesized from the
 * {@link PeerDirectory}.
 */
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

/**
 * Re-shape a `to_device` request's body into the JSON-encoded events array
 * that `OlmMachine.receiveSyncChanges` expects.
 */
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

/**
 * Replace the global `IDBFactory` with a fresh one so each test starts with
 * an empty IndexedDB. `fake-indexeddb/auto` installs a single factory on
 * `globalThis.indexedDB`; replacing it is enough to isolate tests because no
 * other code in this file holds a reference to the previous factory.
 */
async function resetIdb(): Promise<void> {
  const mod = await import("fake-indexeddb");
  const FactoryCtor = (mod as { IDBFactory: { new (): IDBFactory } }).IDBFactory;
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FactoryCtor();
}
