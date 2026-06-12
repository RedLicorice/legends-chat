/**
 * SDK bootstrap contract: importing `@legends/bot-sdk` from a cold module
 * graph must install the IndexedDB polyfill itself. Consumers (jane, chaos,
 * future bots) should not have to know about `fake-indexeddb/auto` — that is
 * an implementation detail of the bot crypto stack.
 *
 * This test deliberately does NOT import `fake-indexeddb/auto` at the top
 * (unlike every sibling test). If the SDK entry doesn't side-effect-install
 * the polyfill, `indexedDB` will be undefined and the assertion fails.
 */
import { describe, it, expect } from "vitest";

describe("@legends/bot-sdk public entry", () => {
  it("installs an IndexedDB polyfill at import time", async () => {
    // Sanity: in plain Node, `indexedDB` is not a thing. If something else in
    // the test runner has already poisoned the global, this test would be
    // meaningless — guard against that by only asserting the post-import state.
    await import("../src/index.js");
    expect(typeof globalThis.indexedDB).not.toBe("undefined");
  });
});
