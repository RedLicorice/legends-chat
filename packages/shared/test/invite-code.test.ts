import { describe, expect, it } from "vitest";
import {
  INVITE_CODE_ALPHABET,
  INVITE_CODE_BODY_LENGTH,
  INVITE_CODE_LENGTH,
  INVITE_CODE_PREFIX,
  INVITE_CODE_REGEX,
  formatInviteCodeFromBytes,
} from "../src/invite-code";

describe("invite codes", () => {
  it("has enough entropy that an online guesser is hopeless", () => {
    // 32^12 = 2^60. The old 6-character body was 2^30, sweepable in hours.
    expect(INVITE_CODE_ALPHABET).toHaveLength(32);
    expect(INVITE_CODE_BODY_LENGTH).toBeGreaterThanOrEqual(12);
  });

  it("consumes one random byte per body character", () => {
    // The bug this guards: the generator asked for 12 bytes while the
    // formatter read only the first 6, silently discarding the extra entropy.
    const bytes = new Uint8Array(INVITE_CODE_BODY_LENGTH);
    const flipped = new Uint8Array(INVITE_CODE_BODY_LENGTH);
    flipped[INVITE_CODE_BODY_LENGTH - 1] = 1;
    expect(formatInviteCodeFromBytes(bytes)).not.toBe(formatInviteCodeFromBytes(flipped));
  });

  it("rejects short byte input rather than padding it", () => {
    expect(() => formatInviteCodeFromBytes(new Uint8Array(INVITE_CODE_BODY_LENGTH - 1)))
      .toThrow(/random bytes/);
  });

  it("produces codes matching the exported regex and length", () => {
    const bytes = new Uint8Array(INVITE_CODE_BODY_LENGTH);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i * 7;
    const code = formatInviteCodeFromBytes(bytes);
    expect(code).toHaveLength(INVITE_CODE_LENGTH);
    expect(code.startsWith(INVITE_CODE_PREFIX)).toBe(true);
    expect(INVITE_CODE_REGEX.test(code)).toBe(true);
  });

  it("honours a custom prefix", () => {
    const code = formatInviteCodeFromBytes(new Uint8Array(INVITE_CODE_BODY_LENGTH), "TEST#");
    expect(code.startsWith("TEST#")).toBe(true);
    expect(code).toHaveLength("TEST#".length + INVITE_CODE_BODY_LENGTH);
  });

  it("uses an unambiguous alphabet (no 0/O/1/I)", () => {
    for (const ch of "01OI") expect(INVITE_CODE_ALPHABET).not.toContain(ch);
  });
});
