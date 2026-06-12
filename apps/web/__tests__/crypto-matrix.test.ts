import { describe, it, expect } from "vitest";
import {
  toMatrixUserId, fromMatrixUserId,
  toMatrixBotId, fromMatrixBotId,
  parseMatrixPrincipal,
} from "@/lib/crypto-matrix";

const U = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

describe("matrix id helpers (user + bot namespace)", () => {
  it("round-trips a bot id", () => {
    const mx = toMatrixBotId(B);
    expect(mx).toBe(`@bot.${B}:legends.local`);
    expect(fromMatrixBotId(mx)).toBe(B);
  });

  it("user helpers do not match the bot namespace", () => {
    expect(fromMatrixUserId(toMatrixBotId(B))).toBeNull();
  });

  it("bot helpers do not match the user namespace", () => {
    expect(fromMatrixBotId(toMatrixUserId(U))).toBeNull();
  });

  it("parseMatrixPrincipal disambiguates user vs bot", () => {
    expect(parseMatrixPrincipal(toMatrixUserId(U))).toEqual({ type: "user", id: U });
    expect(parseMatrixPrincipal(toMatrixBotId(B))).toEqual({ type: "bot", id: B });
    expect(parseMatrixPrincipal("@garbage:legends.local")).toBeNull();
    expect(parseMatrixPrincipal("not-a-matrix-id")).toBeNull();
  });
});
