import { describe, it, expect } from "vitest";
import { buildDmKey } from "./dm-key";

describe("buildDmKey", () => {
  it("is order-independent (same pair → same key)", () => {
    const a = buildDmKey({ type: "user", id: "11111111-1111-1111-1111-111111111111" }, { type: "user", id: "22222222-2222-2222-2222-222222222222" });
    const b = buildDmKey({ type: "user", id: "22222222-2222-2222-2222-222222222222" }, { type: "user", id: "11111111-1111-1111-1111-111111111111" });
    expect(a).toBe(b);
  });

  it("encodes principal type in the key", () => {
    const k = buildDmKey({ type: "user", id: "aaa" }, { type: "bot", id: "bbb" });
    expect(k).toBe("b:bbb|u:aaa");
  });

  it("distinguishes a user and a bot with the same id", () => {
    const k1 = buildDmKey({ type: "user", id: "x" }, { type: "user", id: "y" });
    const k2 = buildDmKey({ type: "user", id: "x" }, { type: "bot", id: "y" });
    expect(k1).not.toBe(k2);
  });

  it("rejects a self-pair", () => {
    expect(() => buildDmKey({ type: "user", id: "x" }, { type: "user", id: "x" })).toThrow();
  });
});
