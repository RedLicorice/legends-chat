/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@legends/db", "@legends/shared", "@legends/crypto"],
  serverExternalPackages: ["postgres", "ioredis"],
  webpack(config) {
    // Suppress the "Serializing big strings impacts deserialization performance"
    // warning that webpack emits for large strings in its persistent cache.
    // It's a cache-layer perf hint, not a code issue.
    config.infrastructureLogging = { level: "error" };
    return config;
  },
};

export default nextConfig;
