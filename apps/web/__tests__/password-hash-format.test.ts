import { describe, expect, it } from "vitest";
import { scrypt as scryptCb } from "node:crypto";
import { hashPassword, needsRehash, verifyPassword } from "@/lib/password";

// Reproduce a record in the OLD unparameterised format (`scrypt:salt:hash`,
// Node's defaults) so we can prove those still verify and are flagged for
// upgrade.
function legacyHash(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, 32, (err, key) =>
      err ? reject(err) : resolve(`scrypt:${salt}:${key.toString("hex")}`));
  });
}

describe("password hashing", () => {
  it("stores cost parameters in the record", async () => {
    const stored = await hashPassword("correct horse battery staple");
    const parts = stored.split("$");
    expect(parts[0]).toBe("scrypt");
    expect(Number(parts[1])).toBe(1 << 17); // N
    expect(Number(parts[2])).toBe(8); // r
    expect(Number(parts[3])).toBe(1); // p
    expect(parts).toHaveLength(6);
  });

  it("round-trips", async () => {
    const stored = await hashPassword("s3cret-passphrase");
    await expect(verifyPassword("s3cret-passphrase", stored)).resolves.toBe(true);
    await expect(verifyPassword("s3cret-passphras", stored)).resolves.toBe(false);
    await expect(verifyPassword("", stored)).resolves.toBe(false);
  });

  it("uses a fresh salt per hash", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });

  it("still verifies legacy scrypt:salt:hash records", async () => {
    const stored = await legacyHash("old-password", "deadbeef");
    await expect(verifyPassword("old-password", stored)).resolves.toBe(true);
    await expect(verifyPassword("wrong", stored)).resolves.toBe(false);
  });

  it("flags legacy records for rehash and current ones not", async () => {
    expect(needsRehash(await legacyHash("old-password", "deadbeef"))).toBe(true);
    expect(needsRehash(await hashPassword("new-password"))).toBe(false);
  });

  it("treats missing or unrecognised records as neither valid nor upgradable", async () => {
    expect(needsRehash(null)).toBe(false);
    expect(needsRehash(undefined)).toBe(false);
    expect(needsRehash("bcrypt$whatever")).toBe(false);
    await expect(verifyPassword("x", "garbage")).resolves.toBe(false);
    await expect(verifyPassword("x", "scrypt$abc$8$1$salt$hash")).resolves.toBe(false);
  });

  it("refuses absurd cost parameters rather than trying to honour them", async () => {
    // A tampered record must not be able to turn one login into a
    // memory-exhaustion DoS.
    await expect(
      verifyPassword("x", `scrypt$${1 << 25}$8$1$deadbeef$00`),
    ).resolves.toBe(false);
  });
});
