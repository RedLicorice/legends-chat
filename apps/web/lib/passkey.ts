// Shared RP config for passkey routes

export function getRpConfig() {
  const origin = process.env.APP_PUBLIC_URL ?? "http://localhost:3000";
  const url = new URL(origin);
  return {
    rpName: process.env.COMMUNITY_NAME ?? "Legends Chat",
    rpID: url.hostname,
    origin,
  };
}
