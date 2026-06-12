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

// outgoingRequests starts non-empty (initial KeysUpload from bootstrap), then
// drains. We track call count so we can return [] after the first drain.
let outgoingRequestsCalls = 0;
const initialUploadRequest = {
  id: "upload-1",
  type: RequestType.KeysUpload as number,
  body: JSON.stringify({ device_keys: {}, one_time_keys: {} }),
};

const machineInstance = {
  identityKeys: {
    ed25519: { toBase64: () => "ZWQyNTUxOWJhc2U2NA==" },
    curve25519: { toBase64: () => "Y3VydmUyNTUxOWJhc2U2NA==" },
  },
  outgoingRequests: vi.fn(async () => {
    callOrder.push("outgoingRequests");
    outgoingRequestsCalls += 1;
    return outgoingRequestsCalls === 1 ? [initialUploadRequest] : [];
  }),
  markRequestAsSent: vi.fn(async (_id: string, _type: number, _resp: string) => {
    callOrder.push("markRequestAsSent");
    return undefined;
  }),
  updateTrackedUsers: vi.fn(async (users: FakeUserId[]) => {
    callOrder.push("updateTrackedUsers");
    updateTrackedUsersArgs.push(users.map((u) => u.value));
    return undefined;
  }),
  getMissingSessions: vi.fn(async (users: FakeUserId[]) => {
    callOrder.push("getMissingSessions");
    getMissingSessionsArgs.push(users.map((u) => u.value));
    return claimRequest;
  }),
  shareRoomKey: vi.fn(
    async (roomId: FakeRoomId, users: FakeUserId[], _s: FakeEncryptionSettings) => {
      callOrder.push("shareRoomKey");
      shareRoomKeyArgs.push({
        roomId: roomId.value,
        users: users.map((u) => u.value),
      });
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
});

afterEach(() => {
  // Reset module-level state in the test fake.
  outgoingRequestsCalls = 0;
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

  it("orders calls: updateTrackedUsers -> getMissingSessions -> keys/claim -> shareRoomKey -> sendToDevice -> pumpOutgoing", async () => {
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
      | "keys/claim"
      | "sendToDevice"
      | "pumpOutgoing";
    const ops: Op[] = callOrder
      .map((tag): Op | null => {
        if (tag.startsWith("fetch:")) {
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
    const iMissing = indexOf("getMissingSessions");
    const iClaim = indexOf("keys/claim");
    const iShare = indexOf("shareRoomKey");
    const iSend = indexOf("sendToDevice");
    const iPump = indexOf("pumpOutgoing");

    expect(iTrack, `updateTrackedUsers missing — ops=${JSON.stringify(ops)}`).toBeGreaterThanOrEqual(0);
    expect(iMissing, "getMissingSessions missing").toBeGreaterThanOrEqual(0);
    expect(iClaim, "keys/claim fetch missing").toBeGreaterThanOrEqual(0);
    expect(iShare, "shareRoomKey missing").toBeGreaterThanOrEqual(0);
    expect(iSend, "sendToDevice fetch missing").toBeGreaterThanOrEqual(0);
    expect(iPump, "pumpOutgoing (outgoingRequests drain) missing").toBeGreaterThanOrEqual(0);

    // Strict ordering of the security-sensitive prefix.
    expect(iTrack).toBeLessThan(iMissing);
    expect(iMissing).toBeLessThan(iClaim);
    expect(iClaim).toBeLessThan(iShare);
    expect(iShare).toBeLessThan(iSend);
    // pumpOutgoing must come after the share/send pair (final drain).
    expect(iSend).toBeLessThan(iPump);
  });
});
