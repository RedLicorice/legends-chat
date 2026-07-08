import { lookup } from "node:dns/promises";
import { isBlockedIp } from "@legends/shared";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

// Throw unless `raw` is an https:// URL whose EVERY resolved address is public.
// Literal-IP hosts are covered — dns.lookup echoes the literal back, so
// https://169.254.169.254/ and https://[::1]/ are rejected too.
export async function assertPublicHttpsUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError("invalid URL");
  }
  if (u.protocol !== "https:") throw new SsrfError("URL must use HTTPS");

  let addrs: { address: string }[];
  try {
    addrs = await lookup(u.hostname, { all: true });
  } catch {
    throw new SsrfError("host does not resolve");
  }
  if (addrs.length === 0) throw new SsrfError("host does not resolve");
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new SsrfError(`host resolves to a non-public address (${a.address})`);
    }
  }
}

// Webhook fetch that (1) validates the URL resolves to a public https host and
// (2) refuses to follow redirects — a 3xx to an internal URL is the classic
// SSRF bypass. A redirect response is returned as-is (non-2xx → caller treats
// it as a failed delivery).
export async function safeWebhookFetch(url: string, init: RequestInit): Promise<Response> {
  await assertPublicHttpsUrl(url);
  return fetch(url, { ...init, redirect: "manual" });
}
