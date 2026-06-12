/**
 * `pumpOutgoing` single-flight race — a new pump caller must drain requests
 * scheduled AFTER the in-flight pump's last `outgoingRequests()` poll.
 *
 * Symptom (E2E #8): even with `ensureDmSession` running
 *   updateTrackedUsers → pumpOutgoing → getMissingSessions → claim → shareRoomKey
 * in the right order, the browser-side wasm panics:
 *
 *   matrix-sdk-crypto-0.17.0/src/session_manager/group_sessions/mod.rs:218:54
 *   "Session wasn't created nor shared"  →  RuntimeError: unreachable
 *
 * Root cause (not the wire shapes — those are spec-correct, see
 * api-crypto-keys-bot-matrix-shape.test.ts): the single-flight mutex
 * around `pumpOutgoing` works as documented for de-duplication but
 * SWALLOWS a needed drain when another caller schedules a new request
 * during the in-flight pump's last empty `outgoingRequests()` poll.
 *
 * Realistic race (browser tab):
 *   t0: pollSync (running every 5s) calls pumpOutgoing(); pump A starts.
 *   t1: pump A's `outgoingRequests()` returns []. The for-loop is about
 *       to `return` — but hasn't yet reached the finally block.
 *   t2: ensureDmSession runs `await machine.updateTrackedUsers(...)` —
 *       wasm enqueues a KeysQuery in its internal outgoing queue.
 *   t3: ensureDmSession calls `pumpOutgoing()`. `pumpInFlight !== null`
 *       (pump A's finally hasn't fired), so it `await pumpInFlight; return;`.
 *   t4: pump A's finally fires, clears `pumpInFlight`, resolves the
 *       promise. Pump B's await returns, then `return` — never starting
 *       a fresh iteration that would have polled `outgoingRequests` and
 *       drained the KeysQuery from t2.
 *   t5: ensureDmSession calls `getMissingSessions(...)` — wasm has no
 *       peer device list (the KeysQuery never ran), returns null.
 *   t6: No claim. shareRoomKey panics.
 *
 * Fix: `pumpOutgoing`'s contract must be "by the time I return, every
 * request that was scheduled BEFORE my call has been drained". The
 * minimal change: a "generation counter" — each `pumpOutgoing()` call
 * bumps a counter, and the in-flight pump's loop keeps going while the
 * observed counter is less than the requested one. Concurrent callers
 * still de-duplicate (only one loop runs at a time), but no caller
 * returns without having had its request scheduling drained.
 *
 * This test drives the race deterministically by gating the
 * `outgoingRequests()` mock so we can choreograph the exact pump A vs
 * pump B interleave that loses the drain in real browsers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Fake wasm classes (minimum surface crypto.ts uses) ───────────────────────

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

// Queue of requests the wasm wants to emit. Each `outgoingRequests` call
// drains it. `updateTrackedUsers` pushes a KeysQuery — modelling the wasm.
const outgoingQueue: Array<{
  id: string;
  type: number;
  body: string;
  event_type?: string;
  txn_id?: string;
}> = [];

const fakeMachine = {
  identityKeys: {
    ed25519: { toBase64: () => "ZQ==" },
    curve25519: { toBase64: () => "Y3Y=" },
  },
  outgoingRequests: vi.fn(async () => outgoingQueue.splice(0)),
  markRequestAsSent: vi.fn(
    async (_id: string, _type: number, _resp: string) => undefined,
  ),
  updateTrackedUsers: vi.fn(async (_users: FakeUserId[]) => {
    outgoingQueue.push({
      id: `kq-${Math.random()}`,
      type: RequestType.KeysQuery as number,
      body: JSON.stringify({ device_keys: {} }),
    });
  }),
  getMissingSessions: vi.fn(),
  shareRoomKey: vi.fn(),
  encryptRoomEvent: vi.fn(),
  decryptRoomEvent: vi.fn(),
  receiveSyncChanges: vi.fn(async () => []),
  invalidateGroupSession: vi.fn(),
  getUserDevices: vi.fn(),
  close: vi.fn(),
};

vi.mock("@matrix-org/matrix-sdk-crypto-wasm", () => ({
  initAsync: vi.fn(async () => {}),
  OlmMachine: { initialize: vi.fn(async () => fakeMachine) },
  UserId: FakeUserId,
  DeviceId: FakeDeviceId,
  RoomId: FakeRoomId,
  DeviceLists: FakeDeviceLists,
  EncryptionSettings: FakeEncryptionSettings,
  DecryptionSettings: FakeDecryptionSettings,
  TrustRequirement,
  RequestType,
}));

// Stub IndexedDB (the meta store: device id + sync cursor).
type FakeReq = {
  onsuccess: ((this: unknown) => void) | null;
  onerror: ((this: unknown) => void) | null;
  onupgradeneeded: ((this: unknown) => void) | null;
  result: unknown;
  error: unknown;
};
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
    req.result = fakeStoreData.get(key);
    queueMicrotask(() => req.onsuccess?.call(req));
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
    queueMicrotask(() => req.onsuccess?.call(req));
    return req;
  },
};
const fakeDb = {
  transaction: () => {
    const tx = {
      objectStore: () => fakeStore,
      oncomplete: null as ((this: unknown) => void) | null,
      onerror: null as ((this: unknown) => void) | null,
      error: null as unknown,
    };
    queueMicrotask(() => tx.oncomplete?.call(tx));
    return tx;
  },
  createObjectStore: () => fakeStore,
};
(globalThis as unknown as { indexedDB: unknown }).indexedDB = {
  open: () => {
    const req: FakeReq = {
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      result: fakeDb,
      error: null,
    };
    queueMicrotask(() => req.onsuccess?.call(req));
    return req;
  },
};

// Stub fetch (no real network).
(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(
  async () =>
    ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({}),
    }) as unknown as Response,
);
const gThis = globalThis as unknown as {
  crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array };
};
if (!gThis.crypto) gThis.crypto = {};
if (!gThis.crypto.getRandomValues) {
  gThis.crypto.getRandomValues = (buf: Uint8Array) => {
    for (let i = 0; i < buf.length; i++) buf[i] = i;
    return buf;
  };
}

const cryptoMod = await import("@/lib/crypto");

beforeEach(() => {
  outgoingQueue.length = 0;
  fakeMachine.outgoingRequests.mockReset();
  fakeMachine.outgoingRequests.mockImplementation(async () =>
    outgoingQueue.splice(0),
  );
  fakeMachine.updateTrackedUsers.mockClear();
  fakeMachine.markRequestAsSent.mockClear();
});

describe("pumpOutgoing single-flight — concurrent callers must not lose drains", () => {
  it("when pump B is called AFTER pump A's last empty poll but BEFORE pump A's mutex clears, pump B must still drain the request that was queued in that window", async () => {
    await cryptoMod.initCrypto("11111111-1111-1111-1111-111111111111");

    // Choreograph:
    //   pump A's first outgoingRequests() returns [] (empty queue).
    //   THEN pump B is called.
    //   THEN the wasm enqueues a KeysQuery (via updateTrackedUsers).
    //   THEN pump A's IIFE finalizes (clearing pumpInFlight).
    //   Pump B's `await pumpInFlight` resolves.
    //   Bug: pump B `return`s without polling — KeysQuery lost.
    //   Fix: pump B polls outgoingRequests and drains the KeysQuery.

    let pumpAOutgoingRequestsCalls = 0;
    let pumpAResolveFirstPoll: (() => void) | null = null;
    let pumpAFirstPollWaiting: Promise<void> | null = null;

    // Patch outgoingRequests so the FIRST call (pump A's first poll)
    // returns [] but pauses before resolving, giving us a hook to schedule
    // a fresh request mid-flight.
    fakeMachine.outgoingRequests.mockReset();
    fakeMachine.outgoingRequests.mockImplementation(async () => {
      pumpAOutgoingRequestsCalls++;
      if (pumpAOutgoingRequestsCalls === 1) {
        // First poll: pause until the test resumes us. We will resume AFTER
        // pump B is in-flight and a KeysQuery has been enqueued.
        pumpAFirstPollWaiting = new Promise<void>((r) => {
          pumpAResolveFirstPoll = r;
        });
        await pumpAFirstPollWaiting;
        // Return [] — modelling "nothing to do at the moment pump A
        // observed the queue".
        return [];
      }
      return outgoingQueue.splice(0);
    });

    // t0: pump A starts.
    const pumpAPromise = cryptoMod.pumpOutgoing();

    // Yield microtasks so pump A reaches the gated outgoingRequests poll.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(pumpAResolveFirstPoll, "pump A should have entered outgoingRequests").not.toBeNull();

    // t2: a concurrent task (e.g. ensureDmSession) schedules a KeysQuery.
    await fakeMachine.updateTrackedUsers([new FakeUserId("@bot.x:legends.local")]);
    expect(outgoingQueue.length).toBe(1);

    // t3: that same task invokes pumpOutgoing(). Pump A is still in-flight
    //     (paused inside outgoingRequests). So pump B sees `pumpInFlight`,
    //     awaits it, and (with the BUG) returns immediately afterward.
    const pumpBPromise = cryptoMod.pumpOutgoing();

    // Yield microtasks so pump B reaches `await pumpInFlight`.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // t4: release pump A. Its first poll resolves with []. The for-loop
    //     exits with `return`, finally clears `pumpInFlight`, the IIFE
    //     resolves, and pump B's await wakes up.
    pumpAResolveFirstPoll!();

    await pumpAPromise;
    await pumpBPromise;

    // Pump B SHOULD have polled outgoingRequests and drained the KeysQuery
    // that was queued before pump B was invoked. With the bug, pump B
    // returned without polling.
    expect(
      fakeMachine.markRequestAsSent.mock.calls.length,
      "pump B must drain the KeysQuery that was queued before it was called; if it doesn't, ensureDmSession's getMissingSessions returns null, no claim runs, and shareRoomKey panics with \"Session wasn't created nor shared\" in real browsers",
    ).toBeGreaterThan(0);
    expect(
      fakeMachine.markRequestAsSent.mock.calls.some(
        (c) => c[1] === RequestType.KeysQuery,
      ),
    ).toBe(true);
    // Sanity: the KeysQuery should have been consumed from the queue.
    expect(outgoingQueue.length).toBe(0);
  });
});
