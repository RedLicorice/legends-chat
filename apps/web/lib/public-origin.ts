import type { NextRequest } from "next/server";

/**
 * Edge-runtime-safe version — no Node.js built-ins.
 * Used by middleware.ts (Edge Runtime).
 *
 * Reads x-forwarded-proto + x-forwarded-host headers set by ngrok / any
 * reverse proxy. Falls back to req.nextUrl.origin for direct access.
 */
export function publicOrigin(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto");
  const host = req.headers.get("x-forwarded-host");
  if (proto && host) return `${proto}://${host}`;
  return req.nextUrl.origin;
}
