import { describe, it, expect } from "vitest";
import { isBlockedIp } from "../src/index";

describe("isBlockedIp", () => {
  it("blocks IPv4 internal ranges", () => {
    for (const ip of [
      "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", // metadata
      "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1",
      "192.0.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("blocks IPv6 internal + IPv4-mapped internal", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:169.254.169.254", "::ffff:10.0.0.1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows global-unicast IPv6 and IPv4-mapped public", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("blocks malformed input (fail closed)", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("999.999.999.999")).toBe(true);
  });
});
