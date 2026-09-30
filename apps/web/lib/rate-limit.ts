import { NextResponse } from "next/server";
import { redis } from "./redis";

export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: number };

// Client IP for keying auth limits.
//
// Prod topology: Client → Cloudflare → Traefik → nginx → Next. Cloudflare sets
// CF-Connecting-IP to the real client at the edge and OVERWRITES any value the
// client tried to send, so it's the only non-spoofable source; Traefik and
// nginx pass it through untouched. Do NOT trust X-Forwarded-For's leading entry
// (nginx uses $proxy_add_x_forwarded_for, which appends the real peer AFTER any
// client-supplied value — a client could spoof the front and rotate it per
// request to defeat the limit). X-Real-IP here is nginx's socket peer (Traefik),
// constant across users, so it's only a last-ditch fallback.
//
// ⚠ Deployment invariant: the origin (Traefik/nginx) MUST be firewalled to
// Cloudflare's IP ranges. If an attacker can reach the origin directly,
// CF-Connecting-IP becomes client-controlled again.
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return normalizeIp(cf);
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return normalizeIp(realIp);
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return normalizeIp(parts[parts.length - 1]!);
  }
  return "unknown";
}

// Collapse an address to the smallest unit an attacker can't trivially
// multiply, so it can serve as a rate-limit bucket key.
//
// IPv4 keys on the full /32 — one address is one host and another one costs
// real money. IPv6 does not work that way: the smallest block anyone is
// assigned is a /64, so a $3/month VPS with a routed /64 has 2^64 source
// addresses to rotate through. Keying on the full /128 handed every per-IP
// limit in the app (register 5/h, login 20/15min, passkey, telegram-register)
// an unlimited supply of fresh Redis buckets — and unbounded key creation with
// it. Truncating to /64 makes one bucket per assignment, which is the unit an
// ISP actually hands out.
export function normalizeIp(raw: string): string {
  const ip = raw.trim().toLowerCase();
  if (!ip) return "unknown";

  // Bracketed and/or port-suffixed forms: "[2001:db8::1]:443", "1.2.3.4:443".
  let addr = ip;
  if (addr.startsWith("[")) {
    const close = addr.indexOf("]");
    if (close > 0) addr = addr.slice(1, close);
  } else {
    const colon = addr.indexOf(":");
    // A single colon means IPv4:port; two or more mean a bare IPv6 address.
    if (colon > 0 && addr.indexOf(":", colon + 1) === -1) addr = addr.slice(0, colon);
  }

  if (!addr.includes(":")) return addr; // IPv4 — keep the full /32.

  // IPv4-mapped IPv6 ("::ffff:1.2.3.4") is really an IPv4 host; key it as one.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) return mapped[1]!;

  return ipv6Prefix64(addr);
}

// First four hextets of an IPv6 address as "<h0>:<h1>:<h2>:<h3>::/64",
// zero-padded so textual variants of the same prefix key identically. Handles
// "::" compression and a "%zone" suffix. Falls back to the input unchanged if
// it doesn't parse — a malformed value then still keys consistently and never
// collapses two different clients into one bucket.
function ipv6Prefix64(addr: string): string {
  const zoneless = addr.split("%")[0]!;
  const halves = zoneless.split("::");
  if (halves.length > 2) return addr;

  const head = halves[0] ? halves[0]!.split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1]!.split(":") : [];
  if (head.some((h) => h === "") || tail.some((h) => h === "")) return addr;

  let hextets: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return addr;
    hextets = [...head, ...Array<string>(fill).fill("0"), ...tail];
  } else {
    if (head.length !== 8) return addr;
    hextets = head;
  }

  const prefix = hextets.slice(0, 4);
  if (prefix.length !== 4 || prefix.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return addr;
  return `${prefix.map((h) => h.padStart(4, "0")).join(":")}::/64`;
}

// Increment `key`; return a ready-to-send 429 if over the limit, else null.
export async function enforceRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<NextResponse | null> {
  const res = await checkAndIncrement(key, limit, windowSeconds);
  if (res.allowed) return null;
  const retryAfter = Math.max(1, Math.ceil((res.resetAt - Date.now()) / 1000));
  return NextResponse.json(
    { error: "Too many requests", retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

// INCR then EXPIRE-on-first-hit. If the key was new, INCR returns 1 and we set
// the TTL. Subsequent hits within the window inherit the TTL. Slight race on
// the very first call (two callers can both see 1) is fine — TTL just gets
// re-set to the same value.
export async function checkAndIncrement(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  const ttl = await redis.ttl(key);
  const effectiveTtl = ttl > 0 ? ttl : windowSeconds;
  const resetAt = Date.now() + effectiveTtl * 1000;
  if (count > limit) {
    return { allowed: false, remaining: 0, resetAt };
  }
  return { allowed: true, remaining: Math.max(0, limit - count), resetAt };
}
