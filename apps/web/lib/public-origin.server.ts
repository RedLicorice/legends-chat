import type { NextRequest } from "next/server";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const NGROK_ENV_FILE = resolve(ROOT, "logs/ngrok.env");

function ngrokPublicUrl(): string | null {
  try {
    if (!existsSync(NGROK_ENV_FILE)) return null;
    const match = readFileSync(NGROK_ENV_FILE, "utf-8").match(/^APP_PUBLIC_URL=(.+)$/m);
    return match ? (match[1] ?? "").trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * Node.js-runtime version — reads logs/ngrok.env written by scripts/ngrok.mjs.
 * Used by Route Handlers (Node.js Runtime). Do NOT import from middleware.
 *
 * Priority:
 *  1. APP_PUBLIC_URL env var  (set in production docker-compose)
 *  2. logs/ngrok.env  (ngrok public URL, refreshed on each tunnel start)
 *  3. x-forwarded-proto + x-forwarded-host  (generic proxy headers)
 *  4. req.nextUrl.origin  (direct access, no proxy)
 */
export function publicOriginServer(req: NextRequest): string {
  const appPublicUrl = process.env.APP_PUBLIC_URL;
  if (appPublicUrl) return new URL(appPublicUrl).origin;

  const ngrok = ngrokPublicUrl();
  if (ngrok) return new URL(ngrok).origin;

  const proto = req.headers.get("x-forwarded-proto");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (proto && host) return `${proto}://${host}`;

  return req.nextUrl.origin;
}
