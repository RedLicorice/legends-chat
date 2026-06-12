/**
 * createOlmChatCrypto — per-instance init readiness.
 *
 * Bug: in DmRightPane, the `useMemo` for `chatCrypto` rebuilds the closure
 * when its deps (roomKey, peerMatrixId) change. ChatPane previously gated
 * `cc.init(...)` on a shared `e2eeReady` React state, so a fresh cc
 * inherited the old "ready" flag and skipped its own init — leaving its
 * internal `mod` null. The next `encrypt`/`ensureSession` then threw
 * "chat-crypto: not initialized".
 *
 * Fix: readiness lives on the cc closure itself. `ready()` reflects this
 * exact instance's state; `init()` is idempotent so callers can safely
 * always invoke it.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// We mock @/lib/crypto wholesale so the test doesn't drag in the wasm
// matrix-sdk-crypto stack. The spies let us assert on init idempotency.
const initCryptoMock = vi.fn(async (_userId: string) => {});
const bootstrapMock = vi.fn(async () => {});
const ensurePeerTrackedMock = vi.fn(async (_peer: string) => {});
const ensureSessionWithPeerMock = vi.fn(async (_peer: string) => {});
const ensureDmSessionMock = vi.fn(async (_roomKey: string, _peer: string) => {});
const encryptDmMock = vi.fn(async (_roomKey: string, _plaintext: string) => ({
  algorithm: "m.olm.v1.curve25519-aes-sha2" as const,
  sender_key: "sk",
  ciphertext: { "peer-key": { type: 0, body: "ct" } },
  session_id: "sid",
}));

vi.mock("@/lib/crypto", () => ({
  initCrypto: (...args: [string]) => initCryptoMock(...args),
  bootstrap: () => bootstrapMock(),
  ensurePeerTracked: (...args: [string]) => ensurePeerTrackedMock(...args),
  ensureSessionWithPeer: (...args: [string]) => ensureSessionWithPeerMock(...args),
  ensureDmSession: (...args: [string, string]) => ensureDmSessionMock(...args),
  encryptDm: (...args: [string, string]) => encryptDmMock(...args),
  decryptDm: vi.fn(async () => "plaintext"),
  pumpOutgoing: vi.fn(async () => {}),
  pollSync: vi.fn(async () => ({ newToDeviceCount: 0 })),
}));

// Import SUT *after* the mock is registered.
const { createOlmChatCrypto } = await import("@/lib/chat-crypto");

const ROOM_KEY = "room-key-test";
const PEER = "@bot.bot-1:legends.local";
const USER_ID = "user-self";

beforeEach(() => {
  initCryptoMock.mockClear();
  bootstrapMock.mockClear();
  ensurePeerTrackedMock.mockClear();
  ensureSessionWithPeerMock.mockClear();
  ensureDmSessionMock.mockClear();
  encryptDmMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createOlmChatCrypto — per-instance readiness", () => {
  it("ready() is false before init()", () => {
    const cc = createOlmChatCrypto(ROOM_KEY, PEER);
    // `ready` must exist as a callable on the closure so callers can
    // introspect *this* instance — not a shared React state.
    expect(typeof (cc as unknown as { ready?: unknown }).ready).toBe("function");
    const ready = (cc as unknown as { ready: () => boolean }).ready;
    expect(ready()).toBe(false);
  });

  it("ready() is true after init() and encrypt/ensureSession do not throw 'not initialized'", async () => {
    const cc = createOlmChatCrypto(ROOM_KEY, PEER);
    await cc.init(USER_ID);
    const ready = (cc as unknown as { ready: () => boolean }).ready;
    expect(ready()).toBe(true);
    // ensureSession + encrypt must not throw the "not initialized" sentinel.
    await expect(cc.ensureSession([])).resolves.not.toThrow();
    await expect(cc.encrypt("hello")).resolves.toEqual(
      expect.objectContaining({ algorithm: "m.olm.v1.curve25519-aes-sha2" }),
    );
  });

  it("second init() is a no-op — no duplicate wasm bootstrap", async () => {
    const cc = createOlmChatCrypto(ROOM_KEY, PEER);
    await cc.init(USER_ID);
    expect(initCryptoMock).toHaveBeenCalledTimes(1);
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
    // Calling init() again on the same instance must not re-invoke either.
    await cc.init(USER_ID);
    expect(initCryptoMock).toHaveBeenCalledTimes(1);
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
  });

  it("separate cc instances each track their own readiness", async () => {
    const cc1 = createOlmChatCrypto(ROOM_KEY, PEER);
    const cc2 = createOlmChatCrypto("room-key-other", PEER);
    await cc1.init(USER_ID);
    const ready1 = (cc1 as unknown as { ready: () => boolean }).ready;
    const ready2 = (cc2 as unknown as { ready: () => boolean }).ready;
    expect(ready1()).toBe(true);
    // cc2 must not inherit cc1's readiness — readiness is per-instance.
    expect(ready2()).toBe(false);
    await expect(cc2.encrypt("hi")).rejects.toThrow(/not initialized/);
  });
});
