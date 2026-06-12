// Wire-format contract: the `ciphertext` field on the bot API (both
// outgoing sendDmCiphertext/sendTopicCiphertext and incoming
// DmMessageUpdate / MessageUpdate) is a JSON-stringified Matrix
// `m.room.encrypted` CONTENT object. The wasm `encryptRoomEvent` returns
// it as a string; `decryptRoomMessage` parses it before handing to
// `decryptRoomEvent`.
//
// This test exists to lock the contract in one place — if the wire shape
// ever drifts to an object, both the SDK's `JSON.parse` and the server's
// Zod schema have to change in lockstep, and this test will fail loudly.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BotOlmMachine, type OutgoingRequest } from "../../src/crypto/olm-machine.js";
import { OlmStore } from "../../src/crypto/olm-store.js";

describe("ciphertext wire format", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ct-wire-"));
    await resetIdb();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("encryptForRoom returns a JSON string that decryptRoomMessage can round-trip", async () => {
    const bot = await BotOlmMachine.create({
      botId: "bot-w",
      store: new OlmStore(path.join(dir, "bot.pickle")),
    });
    const user = await BotOlmMachine.create({
      botId: "user-w",
      store: new OlmStore(path.join(dir, "user.pickle")),
      matrixId: "@user-w:legends.local",
    });

    const directory = new PeerDirectory();
    await drainRequests(bot, directory);
    await drainRequests(user, directory);

    await bot.updateTrackedUsers([user.getMatrixId()]);
    await user.updateTrackedUsers([bot.getMatrixId()]);
    await drainRequests(bot, directory);
    await drainRequests(user, directory);

    const claim = await bot.getMissingSessions([user.getMatrixId()]);
    if (claim) {
      await bot.markRequestAsSent(claim.id, directory.respondToClaim(claim.body));
    }

    const roomId = "!ct-wire:legends.local";
    const shareReqs = await bot.shareRoomKey(roomId, [user.getMatrixId()]);
    for (const req of shareReqs) {
      await user.receiveSyncChanges({
        toDevice: toDeviceEventsJson(req, bot.getMatrixId()),
        otkCounts: {},
      });
      await bot.markRequestAsSent(req.id, "{}");
    }

    const { ciphertext } = await bot.encryptForRoom(
      roomId,
      "wire-shape check",
      "m.room.message",
    );

    // Wire-shape invariant #1: ciphertext is a string, not an object.
    expect(typeof ciphertext).toBe("string");

    // Wire-shape invariant #2: that string parses to an m.room.encrypted
    // CONTENT object — i.e. it has the spec-named fields a Matrix client
    // would expect inside the `content` of an `m.room.encrypted` event.
    const parsed = JSON.parse(ciphertext) as {
      algorithm?: string;
      ciphertext?: unknown;
      sender_key?: string;
      session_id?: string;
      device_id?: string;
    };
    expect(parsed.algorithm).toBe("m.megolm.v1.aes-sha2");
    expect(typeof parsed.sender_key).toBe("string");
    expect(typeof parsed.session_id).toBe("string");
    expect(typeof parsed.device_id).toBe("string");
    expect(parsed.ciphertext).toBeDefined();

    // Wire-shape invariant #3: feeding the exact same string through
    // decryptRoomMessage recovers the plaintext (no extra wrapping needed
    // on either end — the server just passes the string through).
    const plaintext = await user.decryptRoomMessage(roomId, {
      ciphertext,
      sender: bot.getMatrixId(),
    });
    expect(plaintext).toBe("wire-shape check");
  });
});

// ── helpers (subset of olm-machine.test.ts) ────────────────────────────────

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
