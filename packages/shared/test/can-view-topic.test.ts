import { describe, it, expect } from "vitest";
import { canViewTopic } from "../src/index";

describe("canViewTopic", () => {
  it("allows when no role gates are set", () => {
    expect(canViewTopic("user", null, null)).toBe(true);
    expect(canViewTopic("user", [], [])).toBe(true);
  });

  it("admin bypasses every gate", () => {
    expect(canViewTopic("admin", ["mod"], ["mod"])).toBe(true);
  });

  it("denies when viewRoles excludes the role", () => {
    expect(canViewTopic("user", ["mod"], null)).toBe(false);
  });

  it("denies when readRoles excludes the role", () => {
    expect(canViewTopic("user", null, ["mod"])).toBe(false);
  });

  it("allows when the role is in the gate", () => {
    expect(canViewTopic("mod", ["mod"], ["mod"])).toBe(true);
  });

  it("requires the role to satisfy BOTH gates", () => {
    // in viewRoles but not readRoles → denied
    expect(canViewTopic("mod", ["mod", "user"], ["user"])).toBe(false);
  });
});
