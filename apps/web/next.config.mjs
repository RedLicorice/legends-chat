import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
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
};

export default nextConfig;
