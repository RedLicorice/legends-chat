import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

// Per-build token, stamped into the SW bytes so the served script changes every
// deploy → the browser's SW update check fires and old caches are purged. Uses
// the build-time NEXT_PUBLIC_SW_BUILD when present (stable per deploy), else a
// per-process value (dev restart / fallback).
const SW_BUILD =
  process.env.NEXT_PUBLIC_SW_BUILD || `p${process.pid.toString(36)}`;

let cached: string | null = null;

async function loadStampedSw(): Promise<string> {
  // Cache only in prod — in dev we re-read so edits to sw.tpl.js take effect.
  if (cached && process.env.NODE_ENV === "production") return cached;
  // public/ is copied next to the server in every Docker image, so cwd()/public
  // resolves in both dev and standalone.
  const tpl = await readFile(join(process.cwd(), "public", "sw.tpl.js"), "utf8");
  cached = tpl.replaceAll("__SW_BUILD__", SW_BUILD);
  return cached;
}

export async function GET(): Promise<Response> {
  const body = await loadStampedSw();
  return new Response(body, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // Never cache the SW script itself — the browser must always re-fetch to
      // detect the byte change.
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      // Allow root scope even though the script is served from a route.
      "service-worker-allowed": "/",
    },
  });
}
