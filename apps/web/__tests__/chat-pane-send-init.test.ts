/**
 * ChatPane send/edit cc-acquisition pattern — init must always be awaited.
 *
 * Bug: ChatPane's send() + submitEdit() acquire the chat-crypto via
 *     const cc = chatCryptoRef.current ?? (await ensureCrypto());
 * but `chatCryptoRef.current` is ALWAYS non-null once the parent passes a
 * chatCrypto prop (the ref is seeded with the prop at hook-init time and
 * kept in sync by an effect). The `??` therefore short-circuits and
 * `ensureCrypto()` — the only thing that calls `cc.init(currentUserId)` —
 * is never invoked from the send path.
 *
 * Result: the very first send on a freshly-mounted DM/topic throws
 * "chat-crypto: not initialized" from inside `ensureSession`/`encrypt`,
 * surfacing as the "Encryption setup with peers in progress" banner.
 *
 * Fix: drop the `??` and always `await ensureCrypto()`. `ensureCrypto`
 * short-circuits on `cc.ready()` so the cost is a single microtask hop.
 *
 * This test exercises the smallest reproduction of the caller pattern
 * (per the task's "alternative TDD" guidance) rather than mounting the
 * full ChatPane tree: we model the ref + ensureCrypto pair and verify
 * which code shape actually drives init() on a fresh cc.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// Mock the wasm-backed crypto module so the test stays in pure JS land.
const initCryptoMock = vi.fn(async (_userId: string) => {});
const bootstrapMock = vi.fn(async () => {});
const ensurePeerTrackedMock = vi.fn(async (_peer: string) => {});
const ensureSessionWithPeerMock = vi.fn(async (_peer: string) => {});
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
  encryptDm: (...args: [string, string]) => encryptDmMock(...args),
  decryptDm: vi.fn(async () => "plaintext"),
  pumpOutgoing: vi.fn(async () => {}),
  pollSync: vi.fn(async () => ({ newToDeviceCount: 0 })),
}));

const { createOlmChatCrypto } = await import("@/lib/chat-crypto");
import type { ChatCrypto } from "@/lib/chat-crypto";

const ROOM_KEY = "room-key-test";
const PEER = "@bot.bot-1:legends.local";
const USER_ID = "user-self";

beforeEach(() => {
  initCryptoMock.mockClear();
  bootstrapMock.mockClear();
  ensurePeerTrackedMock.mockClear();
  ensureSessionWithPeerMock.mockClear();
  encryptDmMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Tiny harness mirroring ChatPane's per-instance ensureCrypto closure:
 * it tracks an in-flight init promise so concurrent callers share the
 * same init, and short-circuits when the cc reports ready.
 */
function makeEnsureCrypto(ccRef: { current: ChatCrypto | null }, userId: string) {
  let initPromise: Promise<void> | null = null;
  return async function ensureCrypto(): Promise<ChatCrypto | null> {
    const cc = ccRef.current;
    if (!cc) return null;
    if (cc.ready()) return cc;
    if (initPromise) {
      await initPromise;
      return cc;
    }
    initPromise = (async () => {
      try {
        await cc.init(userId);
      } finally {
        initPromise = null;
      }
    })();
    await initPromise;
    return cc;
  };
}

describe("ChatPane send/edit cc-acquisition pattern", () => {
  it("BUG: `ref.current ?? ensureCrypto()` skips init when the ref is non-null and encrypt throws 'not initialized'", async () => {
    // Simulate ChatPane mounted with a chatCrypto prop: the ref is
    // populated up-front, so the `??` operator never falls through to
    // `ensureCrypto()`. This is the exact pre-fix shape of send() and
    // submitEdit() in apps/web/components/ChatPane.tsx.
    const cc = createOlmChatCrypto(ROOM_KEY, PEER);
    const ccRef: { current: ChatCrypto | null } = { current: cc };
    const ensureCrypto = makeEnsureCrypto(ccRef, USER_ID);

    // Buggy acquisition pattern — verbatim from ChatPane.tsx send().
    const acquired = ccRef.current ?? (await ensureCrypto());
    expect(acquired).toBe(cc);
    // init was NOT invoked: the `??` short-circuited.
    expect(initCryptoMock).not.toHaveBeenCalled();
    expect(bootstrapMock).not.toHaveBeenCalled();
    expect(cc.ready()).toBe(false);

    // Consequently, the very next step (ensureSession + encrypt) blows
    // up with the "not initialized" sentinel — this is the user-facing
    // banner reproduction.
    await expect(acquired!.ensureSession([])).rejects.toThrow(/not initialized/);
    await expect(acquired!.encrypt("ping")).rejects.toThrow(/not initialized/);
  });

  it("FIX: always-await `ensureCrypto()` drives init on the fresh cc and encrypt succeeds", async () => {
    // Same starting state — fresh cc handed in via prop, ref is non-null.
    const cc = createOlmChatCrypto(ROOM_KEY, PEER);
    const ccRef: { current: ChatCrypto | null } = { current: cc };
    const ensureCrypto = makeEnsureCrypto(ccRef, USER_ID);

    // Fixed acquisition pattern — always await ensureCrypto().
    const acquired = await ensureCrypto();
    expect(acquired).toBe(cc);
    // init ran exactly once on this instance.
    expect(initCryptoMock).toHaveBeenCalledTimes(1);
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
    expect(cc.ready()).toBe(true);

    // ensureSession + encrypt no longer throw the sentinel.
    await expect(acquired!.ensureSession([])).resolves.not.toThrow();
    await expect(acquired!.encrypt("ping")).resolves.toEqual(
      expect.objectContaining({ algorithm: "m.olm.v1.curve25519-aes-sha2" }),
    );
    expect(encryptDmMock).toHaveBeenCalledWith(ROOM_KEY, "ping");
  });

  it("FIX: re-invoking the always-await pattern is cheap — init is not repeated", async () => {
    const cc = createOlmChatCrypto(ROOM_KEY, PEER);
    const ccRef: { current: ChatCrypto | null } = { current: cc };
    const ensureCrypto = makeEnsureCrypto(ccRef, USER_ID);

    // First send: triggers init.
    await ensureCrypto();
    expect(initCryptoMock).toHaveBeenCalledTimes(1);

    // Subsequent send: cc.ready() short-circuits ensureCrypto; init is
    // not redone, so dropping the `??` doesn't cost a re-bootstrap on
    // the hot path.
    await ensureCrypto();
    await ensureCrypto();
    expect(initCryptoMock).toHaveBeenCalledTimes(1);
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Source-level regression guard.
 *
 * The behavioral tests above prove the always-await shape is correct, but
 * they don't bind the assertion to ChatPane.tsx itself — without this
 * grep-style test, a future edit could silently re-introduce the
 * `ref.current ??` short-circuit in send()/submitEdit() and the suite
 * would stay green.
 *
 * This test reads ChatPane.tsx and fails if the buggy pattern shows up in
 * the message-path acquisition sites. It is the RED-before-fix lever for
 * the actual file change.
 */
describe("ChatPane.tsx — cc acquisition source guard", () => {
  const CHAT_PANE_PATH = resolve(__dirname, "../components/ChatPane.tsx");

  it("send() and submitEdit() do not short-circuit ensureCrypto via `chatCryptoRef.current ??`", () => {
    const src = readFileSync(CHAT_PANE_PATH, "utf8");
    // Pre-fix, both send() and submitEdit() contained:
    //   const cc = chatCryptoRef.current ?? (await ensureCrypto());
    // This guard accepts whitespace variation but rejects the structural
    // shape: a `chatCryptoRef.current ??` fallthrough to ensureCrypto().
    const buggyPattern = /chatCryptoRef\.current\s*\?\?\s*\(\s*await\s+ensureCrypto/;
    const offenders: string[] = [];
    src.split("\n").forEach((line, i) => {
      if (buggyPattern.test(line)) offenders.push(`L${i + 1}: ${line.trim()}`);
    });
    expect(
      offenders,
      `ChatPane.tsx must always await ensureCrypto() in send/edit paths.\n` +
        `Found buggy short-circuit on:\n${offenders.join("\n")}\n` +
        `Fix: replace \`chatCryptoRef.current ?? (await ensureCrypto())\` with \`await ensureCrypto()\`.`,
    ).toEqual([]);
  });

  it("send() and submitEdit() each contain at least one `await ensureCrypto()` call", () => {
    const src = readFileSync(CHAT_PANE_PATH, "utf8");
    // Sanity check: the fix shape is present. Without this, deleting the
    // call entirely would also pass the previous guard.
    const fixedCount = (src.match(/=\s*await\s+ensureCrypto\(\)/g) ?? []).length;
    // send() and submitEdit() are the two known E2EE-write call sites.
    expect(fixedCount).toBeGreaterThanOrEqual(2);
  });
});
