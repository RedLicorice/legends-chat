import type { NextRequest } from "next/server";

/**
 * Returns the public-facing origin of the request, respecting
 * reverse-proxy headers (ngrok, Cloudflare, load balancers, etc.).
 *
 * Priority:
 *  1. x-forwarded-proto + x-forwarded-host  (set by ngrok / most proxies)
 *  2. APP_PUBLIC_URL env var  (explicit override)
 *  3. req.nextUrl.origin      (direct access, no proxy)
 */
export function publicOrigin(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto");
  const host = req.headers.get("x-forwarded-host");
  if (proto && host) return `${proto}://${host}`;

  const env = process.env.APP_PUBLIC_URL;
  if (env) return new URL(env).origin;

  return req.nextUrl.origin;
}
