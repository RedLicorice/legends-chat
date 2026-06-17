import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
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
