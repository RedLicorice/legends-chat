/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // Prevent Next.js from 308-redirecting /socket.io/ → /socket.io (trailing
  // slash removal). Socket.IO's engine.io only handles requests at /socket.io/
  // (with the slash), so the redirect would break WebSocket upgrades and
  // polling. Custom handling is done in the rewrites below instead.
  skipTrailingSlashRedirect: true,
  transpilePackages: ["@legends/db", "@legends/shared", "@legends/crypto"],
  serverExternalPackages: ["postgres", "ioredis"],
  // Proxy /socket.io/* to the WS server so the browser connects same-origin.
  // This ensures the auth cookie (sameSite: lax) is always sent regardless of
  // whether the WS server is on a different port or ngrok subdomain.
  async rewrites() {
    const wsOrigin = process.env.WS_URL ?? "http://localhost:3001";
    return [
      { source: "/socket.io/", destination: `${wsOrigin}/socket.io/` },
      { source: "/socket.io/:path*", destination: `${wsOrigin}/socket.io/:path*` },
    ];
  },
  webpack(config) {
    // Suppress the "Serializing big strings impacts deserialization performance"
    // warning that webpack emits for large strings in its persistent cache.
    // It's a cache-layer perf hint, not a code issue.
    config.infrastructureLogging = { level: "error" };
    return config;
  },
};

export default nextConfig;
