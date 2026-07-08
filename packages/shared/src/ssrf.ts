// SSRF address guard — pure, no node deps (safe in any bundle). Given an IP
// STRING (already resolved from DNS by the caller), returns true if it is NOT a
// public, routable address: loopback, private, link-local (incl. the cloud
// metadata endpoint 169.254.169.254), CGNAT, multicast, reserved, or the IPv6
// equivalents. The DNS resolution + fetch glue lives per-app (node:dns); this is
// the single source of truth for WHICH ranges are forbidden.
export function isBlockedIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase();

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) → unwrap to the embedded IPv4.
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const v4 = mapped ? mapped[1] : (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr) ? addr : null);

  if (v4) {
    const parts = v4.split(".").map((n) => parseInt(n, 10));
    // malformed / out-of-range → block (fail closed)
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const a = parts[0]!;
    const b = parts[1]!;
    if (a === 0) return true;                          // 0.0.0.0/8 "this host"
    if (a === 10) return true;                         // 10.0.0.0/8 private
    if (a === 127) return true;                        // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0) return true;             // 192.0.0.0/24 + 192.0.2.0/24 special/test
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a >= 224) return true;                         // 224.0.0.0/4 multicast + 240/4 reserved
    return false;                                      // public unicast
  }

  // IPv6
  if (addr === "::1" || addr === "::") return true;    // loopback / unspecified
  const firstHextet = parseInt(addr.split(":")[0] || "", 16);
  if (Number.isNaN(firstHextet)) return true;          // malformed → block
  if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true; // fc00::/7 ULA
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true; // fe80::/10 link-local
  if (firstHextet >= 0xff00) return true;              // ff00::/8 multicast
  if (firstHextet >= 0x2000 && firstHextet <= 0x3fff) return false; // 2000::/3 global unicast
  return true;                                         // anything else → block
}
