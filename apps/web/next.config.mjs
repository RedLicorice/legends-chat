import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Per-build service-worker token. Computed once when this config loads (i.e.
// per `next build` / `next dev` start) and inlined into the client bundle as
// NEXT_PUBLIC_SW_BUILD. The SW registration appends it as `/sw.js?v=<token>`,
// so a new build rotates the SW cache names and evicts stale chunks. Honors an
// explicit SW_BUILD env (e.g. a CI git-sha) when set.
const SW_BUILD = process.env.SW_BUILD || Date.now().toString(36);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  env: { NEXT_PUBLIC_SW_BUILD: SW_BUILD },
  skipTrailingSlashRedirect: true,
  allowedDevOrigins: [
    "100.*",
    "192.168.*",
    "10.*",
    "*.local",
    "*.ts.net",
    "*.*.ts.net",
    "clockworkpi.tail78b0d3.ts.net",
  ],
  transpilePackages: ["@legends/db", "@legends/shared", "@legends/crypto"],
  serverExternalPackages: ["postgres", "ioredis"],
  // Tell Next.js standalone tracing to root at the monorepo root so it can
  // follow pnpm symlinks into the virtual store (.pnpm/) and correctly bundle
  // node_modules into the standalone output.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  async rewrites() {
    const wsOrigin = process.env.WS_URL ?? "http://localhost:3001";
    const botOrigin = `http://localhost:${process.env.BOT_WEBHOOK_PORT ?? 3002}`;
    return [
      { source: "/socket.io/", destination: `${wsOrigin}/socket.io/` },
      { source: "/socket.io/:path*", destination: `${wsOrigin}/socket.io/:path*` },
      { source: "/bot/webhook", destination: `${botOrigin}/bot/webhook` },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // External destinations must never learn the chat origin from a Referer
          // header. Browsers default to strict-origin-when-cross-origin which still
          // leaks the bare origin (chat.example.com). no-referrer suppresses it
          // entirely. Combined with rel="noreferrer" + referrerpolicy="no-referrer"
          // on rendered <a> tags this is belt-and-braces.
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Clickjacking: deny all framing. X-Frame-Options for legacy browsers,
          // CSP frame-ancestors for modern ones (the authoritative directive).
          // NOTE: if this app is ever embedded as a Telegram Mini App on
          // web.telegram.org, relax to `frame-ancestors https://web.telegram.org`.
          { key: "X-Frame-Options", value: "DENY" },
          // HSTS — force HTTPS for two years incl. subdomains. Honored only over
          // TLS, so http://localhost dev is unaffected.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          // Defense-in-depth CSP. Deliberately scoped to directives that don't
          // require per-request nonces: no clickjacking, no plugin/object embeds,
          // no <base> hijack. A locked-down script-src needs nonce plumbing
          // through Next's inline bootstrap — tracked as a follow-up, not set
          // here to avoid breaking the app.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
        ],
      },
      // Service worker bytes must NEVER be cached by the browser HTTP cache.
      // Default Next serving was `public, max-age=14400` (4h), which meant iOS
      // Safari kept stale sw.js bytes for hours after a deploy — the in-page
      // `registration.update()` would short-circuit because the cached bytes
      // looked identical. With no-store every update() call hits the server
      // and the byte-difference check sees the new SW immediately.
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, max-age=0" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
    ];
  },
};

export default nextConfig;
