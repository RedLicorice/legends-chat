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
  if (cf) return cf;
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  return "unknown";
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
