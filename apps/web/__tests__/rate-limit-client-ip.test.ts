import { describe, expect, it, vi } from "vitest";

// clientIp/normalizeIp are pure, but the module imports the shared Redis
// client, which would open a real connection on import.
vi.mock("@/lib/redis", () => ({ redis: {} }));

const { clientIp, normalizeIp } = await import("@/lib/rate-limit");

function req(headers: Record<string, string>): Request {
  return new Request("https://example.test/api/auth/login", { headers });
}

describe("normalizeIp", () => {
  it("keeps IPv4 at the full /32", () => {
    expect(normalizeIp("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("203.0.113.8")).toBe("203.0.113.8");
  });

  it("strips a port from IPv4", () => {
    expect(normalizeIp("203.0.113.7:51234")).toBe("203.0.113.7");
  });

  it("truncates IPv6 to /64 so a routed /64 is a single bucket", () => {
    const a = normalizeIp("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");
    const b = normalizeIp("2001:db8:1234:5678:1111:2222:3333:4444");
    expect(a).toBe(b);
    expect(a).toBe("2001:0db8:1234:5678::/64");
  });

  it("keeps different /64s in different buckets", () => {
    expect(normalizeIp("2001:db8:1234:5678::1")).not.toBe(
      normalizeIp("2001:db8:1234:5679::1"),
    );
  });

  it("normalises textual variants of the same prefix identically", () => {
    const compressed = normalizeIp("2001:db8::1");
    const expanded = normalizeIp("2001:0db8:0000:0000:0000:0000:0000:0001");
    expect(compressed).toBe(expanded);
  });

  it("handles brackets, ports and zone ids", () => {
    expect(normalizeIp("[2001:db8:1234:5678::1]:443")).toBe("2001:0db8:1234:5678::/64");
    expect(normalizeIp("2001:db8:1234:5678::1%eth0")).toBe("2001:0db8:1234:5678::/64");
  });

  it("treats IPv4-mapped IPv6 as the IPv4 host it is", () => {
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("is case-insensitive", () => {
    expect(normalizeIp("2001:DB8:1234:5678::1")).toBe("2001:0db8:1234:5678::/64");
  });

  it("falls back to the input for unparseable values instead of collapsing them", () => {
    expect(normalizeIp("2001:db8::1::2")).toBe("2001:db8::1::2");
    expect(normalizeIp("")).toBe("unknown");
  });
});

describe("clientIp", () => {
  it("prefers CF-Connecting-IP and normalises it", () => {
    expect(
      clientIp(req({
        "cf-connecting-ip": "2001:db8:1234:5678::9",
        "x-forwarded-for": "198.51.100.1",
      })),
    ).toBe("2001:0db8:1234:5678::/64");
  });

  it("falls back to X-Real-IP, then the last X-Forwarded-For entry", () => {
    expect(clientIp(req({ "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(
      clientIp(req({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" })),
    ).toBe("203.0.113.7");
  });

  it("returns 'unknown' when nothing identifies the client", () => {
    expect(clientIp(req({}))).toBe("unknown");
  });
});
