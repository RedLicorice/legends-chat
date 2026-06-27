import { describe, it, expect } from "vitest";
import { routeLevel, backTarget, LIST_ROOTS } from "@/lib/mobile-nav";

describe("routeLevel", () => {
  it("list roots are level 0", () => {
    for (const p of ["/", "/c", "/admin"]) expect(routeLevel(p, false)).toBe(0);
  });
  it("details are level 1", () => {
    for (const p of ["/t/general", "/c/abc", "/c/new", "/settings", "/admin/users"])
      expect(routeLevel(p, false)).toBe(1);
  });
  it("thread param is level 2 on a detail", () => {
    expect(routeLevel("/t/general", true)).toBe(2);
  });
  it("thread param does not promote a list root", () => {
    expect(routeLevel("/", true)).toBe(0);
  });
});

describe("backTarget", () => {
  it("admin details go back to /admin", () => {
    expect(backTarget("/admin/users")).toBe("/admin");
  });
  it("chat details go back to /", () => {
    for (const p of ["/t/general", "/c/abc", "/settings"]) expect(backTarget(p)).toBe("/");
  });
});

describe("LIST_ROOTS", () => {
  it("contains the three roots", () => {
    expect([...LIST_ROOTS].sort()).toEqual(["/", "/admin", "/c"]);
  });
});
