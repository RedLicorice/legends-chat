export function getRpConfig(requestOrigin?: string | null, requestHost?: string | null) {
  const fallback = process.env.APP_PUBLIC_URL ?? "http://localhost:3000";

  if (requestOrigin) {
    const url = new URL(requestOrigin);
    return { rpName: process.env.COMMUNITY_NAME ?? "Legends Chat", rpID: url.hostname, origin: requestOrigin };
  }

  if (requestHost) {
    const hostname = requestHost.split(":")[0]!;
    const port = requestHost.includes(":") ? `:${requestHost.split(":")[1]}` : "";
    const scheme = hostname === "localhost" ? "http" : "https";
    const origin = `${scheme}://${hostname}${port}`;
    return { rpName: process.env.COMMUNITY_NAME ?? "Legends Chat", rpID: hostname, origin };
  }

  const url = new URL(fallback);
  return { rpName: process.env.COMMUNITY_NAME ?? "Legends Chat", rpID: url.hostname, origin: fallback };
}
