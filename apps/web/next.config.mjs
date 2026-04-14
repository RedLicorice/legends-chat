/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@legends/db", "@legends/shared", "@legends/crypto"],
  serverExternalPackages: ["postgres", "ioredis"],
};

export default nextConfig;
