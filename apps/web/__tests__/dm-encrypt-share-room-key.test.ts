/**
 * DM encrypt panic — `ensureDmSession` must call `shareRoomKey` before
 * `encryptRoomEvent`.
 *
 * Bug: on the first send to a freshly-paired E2EE bot DM, the browser-side
 * encrypt panicked deep inside `matrix-sdk-crypto-wasm`:
 *
 *     src/session_manager/group_sessions/mod.rs:218:54
 *     panicked: "Session wasn't created nor shared"
 *
 * followed by `Uncaught RuntimeError: unreachable` (the wasm instance
 * dies). The DM path (`ensureSessionWithPeer` -> `ensureRoomMembersPeers`)
 * did `updateTrackedUsers` + `getMissingSessions` + `keys/claim` but NEVER
 * called `shareRoomKey`. `encryptRoom`/`encryptDm` then asked the machine
 * to `encryptRoomEvent` without an outbound Megolm session => wasm panic.
 *
 * Topic rooms (`ensureRoomMembers`) avoided this because they always
 * called `shareRoomKey` before encrypt.
 *
 * Fix: a new exported `ensureDmSession(roomKey, peerMatrixId)` that
 * mirrors the topic-room flow for a single peer + self, in this order:
 *   updateTrackedUsers -> getMissingSessions -> keys/claim
 *   -> shareRoomKey -> sendToDevice -> pumpOutgoing
 *
 * This test asserts BOTH that `ensureDmSession` exists AND that it makes
 * those calls in the right order — without booting up the real wasm
 * crypto stack (we mock `@matrix-org/matrix-sdk-crypto-wasm`).
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// ── Test fixtures ────────────────────────────────────────────────────────────
const USER_ID = "11111111-1111-1111-1111-111111111111";
const PEER_MATRIX_ID = "@bot.bot-1:legends.local";
const ROOM_KEY = "!conv-1:legends.local";

// Module-level call log we use to assert ordering. Each operation pushes a
// tag in the exact sequence the SUT performed it.
const callOrder: string[] = [];

// We track the most-recent argument lists for spot checks.
const updateTrackedUsersArgs: string[][] = [];
const getMissingSessionsArgs: string[][] = [];
const shareRoomKeyArgs: Array<{ roomId: string; users: string[] }> = [];

// ── Mocks ────────────────────────────────────────────────────────────────────
// Fake wasm SDK. Each call updates `callOrder` and the per-method arg log.

const claimRequest = {
  id: "claim-req-1",
  type: 3 /* RequestType.KeysClaim */,
  body: JSON.stringify({ one_time_keys: {} }),
};

const toDeviceRequest = {
  id: "td-req-1",
  type: 4 /* RequestType.ToDevice */,
  event_type: "m.room.encrypted",
  txn_id: "txn-1",
  body: JSON.stringify({ messages: {} }),
};

class FakeUserId {
  constructor(public readonly value: string) {}
}
class FakeDeviceId {
  constructor(public readonly value: string) {}
}
class FakeRoomId {
  constructor(public readonly value: string) {}
}
class FakeDeviceLists {
  constructor(public readonly changed: unknown[], public readonly left: unknown[]) {}
}
class FakeEncryptionSettings {
  rotationPeriod = 0n;
  rotationPeriodMessages = 0n;
}
class FakeDecryptionSettings {
  constructor(_t: unknown) {}
}

const RequestType = {
  KeysUpload: 0,
  KeysQuery: 1,
  KeysClaim: 3,
  ToDevice: 4,
  SignatureUpload: 5,
  RoomMessage: 6,
  KeysBackup: 7,
} as const;

const TrustRequirement = { Untrusted: 0 } as const;

// Model the wasm machine's "track → query → claim → share" pipeline.
//
//   - `outgoingRequests` returns whatever's in the internal queue.
//   - `updateTrackedUsers` enqueues a KeysQuery (this is what the real
//     wasm does — it does NOT issue the query itself; callers must pump
//     `outgoingRequests` to drain it).
//   - `getMissingSessions` returns a real KeysClaim request ONLY if the
//     prior KeysQuery has been drained (i.e. the device list is known).
//     Otherwise it returns null — modelling the wasm bug that bit fix-25:
//     skip the intermediate pump and the claim never happens, so no Olm
//     session gets established and shareRoomKey panics.
//   - `shareRoomKey` panics when called without a prior keys/claim cycle,
//     mirroring the real "Session wasn't created nor shared" assertion
//     in matrix-sdk-crypto group_sessions/mod.rs:218.
const initialUploadRequest = {
  id: "upload-1",
  type: RequestType.KeysUpload as number,
  body: JSON.stringify({ device_keys: {}, one_time_keys: {} }),
};
const queuedKeysQueryRequest = {
  id: "kq-1",
  type: RequestType.KeysQuery as number,
  body: JSON.stringify({ device_keys: {} }),
};

// Mutable queue and per-test handshake state.
const outgoingQueue: Array<{ id: string; type: number; body: string }> = [];
const sessionState = {
  // True after the KeysQuery scheduled by updateTrackedUsers has been
  // delivered to the server AND `markRequestAsSent` recorded the
  // response — i.e. device list is now known.
  deviceListsKnown: false,
  // True after a keys/claim cycle completed end-to-end — i.e. an Olm 1:1
  // session exists for the peer. Required for shareRoomKey not to panic.
  olmSessionEstablished: false,
};

const machineInstance = {
  identityKeys: {
    ed25519: { toBase64: () => "ZWQyNTUxOWJhc2U2NA==" },
    curve25519: { toBase64: () => "Y3VydmUyNTUxOWJhc2U2NA==" },
  },
  outgoingRequests: vi.fn(async () => {
    callOrder.push("outgoingRequests");
    const out = outgoingQueue.splice(0);
    return out;
  }),
  markRequestAsSent: vi.fn(async (_id: string, type: number, _resp: string) => {
    callOrder.push("markRequestAsSent");
    // KeysQuery response landed → device list now known.
    if (type === RequestType.KeysQuery) {
      sessionState.deviceListsKnown = true;
    }
    // KeysClaim response landed → Olm session now established.
    if (type === RequestType.KeysClaim) {
      sessionState.olmSessionEstablished = true;
    }
    return undefined;
  }),
  updateTrackedUsers: vi.fn(async (users: FakeUserId[]) => {
    callOrder.push("updateTrackedUsers");
    updateTrackedUsersArgs.push(users.map((u) => u.value));
    // Schedule a KeysQuery on the outgoing queue — the wasm contract.
    outgoingQueue.push(queuedKeysQueryRequest);
    return undefined;
  }),
  getMissingSessions: vi.fn(async (users: FakeUserId[]) => {
    callOrder.push("getMissingSessions");
    getMissingSessionsArgs.push(users.map((u) => u.value));
    // Without a prior device-list drain we have nothing to claim against.
    // Returning null here is what causes the downstream shareRoomKey to
    // panic in real life — exactly the bug we're guarding against.
    if (!sessionState.deviceListsKnown) return null;
    return claimRequest;
  }),
  shareRoomKey: vi.fn(
    async (roomId: FakeRoomId, users: FakeUserId[], _s: FakeEncryptionSettings) => {
      callOrder.push("shareRoomKey");
      shareRoomKeyArgs.push({
        roomId: roomId.value,
        users: users.map((u) => u.value),
      });
      // Mirror the wasm panic: shareRoomKey aborts when there's no Olm
      // session to wrap the megolm key into. matrix-sdk-crypto panics
      // with "Session wasn't created nor shared" at
      // session_manager/group_sessions/mod.rs:218 — we throw a JS Error
      // with the same message so test assertions can read it.
      if (!sessionState.olmSessionEstablished) {
        throw new Error("Session wasn't created nor shared");
      }
      return [toDeviceRequest];
    },
  ),
  encryptRoomEvent: vi.fn(async () => "{}"),
  decryptRoomEvent: vi.fn(),
  receiveSyncChanges: vi.fn(async () => []),
  invalidateGroupSession: vi.fn(),
  getUserDevices: vi.fn(),
  close: vi.fn(),
};

const OlmMachineMock = {
  initialize: vi.fn(async () => machineInstance),
};

vi.mock("@matrix-org/matrix-sdk-crypto-wasm", () => ({
  initAsync: vi.fn(async () => {}),
  OlmMachine: OlmMachineMock,
  UserId: FakeUserId,
  DeviceId: FakeDeviceId,
  RoomId: FakeRoomId,
  DeviceLists: FakeDeviceLists,
  EncryptionSettings: FakeEncryptionSettings,
  DecryptionSettings: FakeDecryptionSettings,
  TrustRequirement,
  RequestType,
}));

// Stub IndexedDB enough for the meta store to work (device id + sync cursor).
// crypto.ts uses `indexedDB.open` — provide a tiny fake.
type FakeReq = {
  onsuccess: ((this: unknown, ev?: unknown) => void) | null;
  onerror: ((this: unknown, ev?: unknown) => void) | null;
  onupgradeneeded: ((this: unknown, ev?: unknown) => void) | null;
  result: unknown;
  error: unknown;
};

function fireSuccess(req: FakeReq, result: unknown) {
  req.result = result;
  // Schedule async so handlers attached after creation still fire.
  queueMicrotask(() => req.onsuccess?.call(req));
}

const fakeStoreData = new Map<string, unknown>();

const fakeStore = {
  get(key: string): FakeReq {
    const req: FakeReq = {
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      result: undefined,
      error: null,
    };
    fireSuccess(req, fakeStoreData.get(key));
    return req;
  },
  put(value: unknown, key: string): FakeReq {
    const req: FakeReq = {
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      result: undefined,
      error: null,
    };
    fakeStoreData.set(key, value);
    fireSuccess(req, undefined);
    return req;
  },
};

const fakeTx = {
  objectStore: () => fakeStore,
  oncomplete: null as ((this: unknown) => void) | null,
  onerror: null as ((this: unknown) => void) | null,
  error: null as unknown,
};

const fakeDb = {
  transaction: (_name: string, _mode?: string) => {
    const tx = { ...fakeTx };
    queueMicrotask(() => tx.oncomplete?.call(tx));
    return tx;
  },
  createObjectStore: () => fakeStore,
};

// Attach a global indexedDB stub for the test env.
(globalThis as unknown as { indexedDB: unknown }).indexedDB = {
  open: (_name: string, _ver?: number) => {
    const req: FakeReq = {
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      result: fakeDb,
      error: null,
    };
    queueMicrotask(() => {
      // Skip upgrade — store already provisioned in the fake.
      req.onsuccess?.call(req);
    });
    return req;
  },
};

// Stub global fetch for keys/claim + sendToDevice routes.
const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
  const method = init?.method ?? "GET";
  callOrder.push(`fetch:${method}:${url}`);
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({}),
  } as unknown as Response;
});
// Override the global fetch.
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

// Stub crypto.getRandomValues for the device id generator.
const gThis = globalThis as unknown as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } };
if (!gThis.crypto) {
  gThis.crypto = {};
}
if (!gThis.crypto.getRandomValues) {
  gThis.crypto.getRandomValues = (buf: Uint8Array) => {
    for (let i = 0; i < buf.length; i++) buf[i] = i;
    return buf;
  };
}

// SUT — imported AFTER mocks register.
const cryptoMod = await import("@/lib/crypto");

beforeEach(() => {
  callOrder.length = 0;
  updateTrackedUsersArgs.length = 0;
  getMissingSessionsArgs.length = 0;
  shareRoomKeyArgs.length = 0;
  machineInstance.outgoingRequests.mockClear();
  machineInstance.markRequestAsSent.mockClear();
  machineInstance.updateTrackedUsers.mockClear();
  machineInstance.getMissingSessions.mockClear();
  machineInstance.shareRoomKey.mockClear();
  machineInstance.encryptRoomEvent.mockClear();
  fetchMock.mockClear();
  // Reset wasm-fake state and re-seed the initial KeysUpload that
  // bootstrap() expects.
  outgoingQueue.length = 0;
  outgoingQueue.push(initialUploadRequest);
  sessionState.deviceListsKnown = false;
  sessionState.olmSessionEstablished = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ensureDmSession — must call shareRoomKey before encrypt", () => {
  it("exports a callable ensureDmSession(roomKey, peerMatrixId)", async () => {
    expect(typeof (cryptoMod as Record<string, unknown>).ensureDmSession).toBe(
      "function",
    );
  });

  it("calls shareRoomKey for the room key and includes the peer", async () => {
    // initCrypto seeds the singleton + cachedSession. bootstrap drains the
    // initial KeysUpload.
    await cryptoMod.initCrypto(USER_ID);
    await cryptoMod.bootstrap();
    // Clear setup noise before exercising the helper.
    callOrder.length = 0;
    updateTrackedUsersArgs.length = 0;
    getMissingSessionsArgs.length = 0;
    shareRoomKeyArgs.length = 0;
    machineInstance.shareRoomKey.mockClear();
    machineInstance.updateTrackedUsers.mockClear();
    machineInstance.getMissingSessions.mockClear();

    const ensureDmSession = (
      cryptoMod as unknown as {
        ensureDmSession: (rk: string, peer: string) => Promise<void>;
      }
    ).ensureDmSession;
    await ensureDmSession(ROOM_KEY, PEER_MATRIX_ID);

    // shareRoomKey must have been called at least once with the DM roomKey
    // and the peer in the targeted user set.
    expect(machineInstance.shareRoomKey).toHaveBeenCalled();
    expect(shareRoomKeyArgs.length).toBeGreaterThan(0);
    const last = shareRoomKeyArgs[shareRoomKeyArgs.length - 1]!;
    expect(last.roomId).toBe(ROOM_KEY);
    expect(last.users).toContain(PEER_MATRIX_ID);
  });

  it("orders calls: updateTrackedUsers -> KEYS_QUERY drain -> getMissingSessions -> keys/claim -> shareRoomKey -> sendToDevice -> final pump", async () => {
    await cryptoMod.initCrypto(USER_ID);
    await cryptoMod.bootstrap();
    callOrder.length = 0;

    const ensureDmSession = (
      cryptoMod as unknown as {
        ensureDmSession: (rk: string, peer: string) => Promise<void>;
      }
    ).ensureDmSession;
    await ensureDmSession(ROOM_KEY, PEER_MATRIX_ID);

    // Build a stripped sequence of the operations we care about, in the
    // order they actually happened.
    type Op =
      | "updateTrackedUsers"
      | "getMissingSessions"
      | "shareRoomKey"
      | "keys/query"
      | "keys/claim"
      | "sendToDevice"
      | "pumpOutgoing";
    const ops: Op[] = callOrder
      .map((tag): Op | null => {
        if (tag.startsWith("fetch:")) {
          if (tag.includes("/api/crypto/keys/query")) return "keys/query";
          if (tag.includes("/api/crypto/keys/claim")) return "keys/claim";
          if (tag.includes("/api/crypto/sendToDevice/")) return "sendToDevice";
          return null;
        }
        if (tag === "updateTrackedUsers") return "updateTrackedUsers";
        if (tag === "getMissingSessions") return "getMissingSessions";
        if (tag === "shareRoomKey") return "shareRoomKey";
        if (tag === "outgoingRequests") return "pumpOutgoing";
        return null;
      })
      .filter((x): x is Op => x !== null);

    function indexOf(op: Op): number {
      return ops.indexOf(op);
    }

    const iTrack = indexOf("updateTrackedUsers");
    const iQueryFetch = indexOf("keys/query");
    const iMissing = indexOf("getMissingSessions");
    const iClaim = indexOf("keys/claim");
    const iShare = indexOf("shareRoomKey");
    const iSend = indexOf("sendToDevice");
    // The LAST pump cycle in the sequence — there is also one mid-flow
    // (the intermediate drain of the queued KeysQuery), but the final
    // pump must come after shareRoomKey's to-device requests have been
    // sent.
    const iFinalPump = ops.lastIndexOf("pumpOutgoing");

    expect(iTrack, `updateTrackedUsers missing — ops=${JSON.stringify(ops)}`).toBeGreaterThanOrEqual(0);
    expect(iQueryFetch, "intermediate keys/query fetch missing — ensureDmSession is not pumping after updateTrackedUsers, which causes shareRoomKey to panic in real life").toBeGreaterThanOrEqual(0);
    expect(iMissing, "getMissingSessions missing").toBeGreaterThanOrEqual(0);
    expect(iClaim, "keys/claim fetch missing").toBeGreaterThanOrEqual(0);
    expect(iShare, "shareRoomKey missing").toBeGreaterThanOrEqual(0);
    expect(iSend, "sendToDevice fetch missing").toBeGreaterThanOrEqual(0);
    expect(iFinalPump, "final pumpOutgoing missing").toBeGreaterThanOrEqual(0);

    // Strict ordering of the security-sensitive prefix:
    //   track → query drain → missing → claim → share → send → final pump
    // The intermediate query drain is the bit fix-25 was missing; without
    // it the real wasm machine has no device list when getMissingSessions
    // runs, so no Olm session is established and shareRoomKey panics with
    // "Session wasn't created nor shared" deep inside group_sessions.
    expect(iTrack).toBeLessThan(iQueryFetch);
    expect(iQueryFetch).toBeLessThan(iMissing);
    expect(iMissing).toBeLessThan(iClaim);
    expect(iClaim).toBeLessThan(iShare);
    expect(iShare).toBeLessThan(iSend);
    expect(iSend).toBeLessThan(iFinalPump);
  });

  it("does NOT throw 'Session wasn't created nor shared' — shareRoomKey runs with established Olm sessions", async () => {
    // This is the direct user-visible regression test. The wasm-fake's
    // shareRoomKey throws the exact panic message from
    // matrix-sdk-crypto-0.17.0/src/session_manager/group_sessions/mod.rs:218
    // when it's called without a prior keys/claim cycle. If
    // ensureDmSession ever regresses to skipping the intermediate
    // KeysQuery drain (so getMissingSessions returns null and no claim
    // happens), shareRoomKey will throw here.
    await cryptoMod.initCrypto(USER_ID);
    await cryptoMod.bootstrap();

    const ensureDmSession = (
      cryptoMod as unknown as {
        ensureDmSession: (rk: string, peer: string) => Promise<void>;
      }
    ).ensureDmSession;
    await expect(
      ensureDmSession(ROOM_KEY, PEER_MATRIX_ID),
    ).resolves.toBeUndefined();
    // shareRoomKey was the call that would panic — confirm it ran AND
    // returned successfully (the fake throws on missing Olm session).
    expect(machineInstance.shareRoomKey).toHaveBeenCalled();
  });
});
