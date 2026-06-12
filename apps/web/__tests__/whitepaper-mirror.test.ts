import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("whitepaper mirror", () => {
  it("docs/whitepaper.md and apps/web/public/docs/whitepaper.md are byte-identical", () => {
    const root = resolve(__dirname, "..", "..", "..");
    const a = readFileSync(resolve(root, "docs/whitepaper.md"));
    const b = readFileSync(resolve(root, "apps/web/public/docs/whitepaper.md"));
    expect(a.equals(b)).toBe(true);
  });

  it("Bot DMs section reflects shipped E2EE state machine", () => {
    const root = resolve(__dirname, "..", "..", "..");
    const text = readFileSync(resolve(root, "docs/whitepaper.md"), "utf8");
    expect(text).not.toMatch(/E2EE bot DMs \(planned\)/);
    expect(text).toMatch(/E2EE bot DMs/);
    expect(text).toMatch(/disabled.*pending.*ready/i);
    expect(text).toMatch(/bot host/i);
  });
});
