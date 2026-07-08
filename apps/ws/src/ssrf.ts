import { lookup } from "node:dns/promises";
import { isBlockedIp } from "@legends/shared";

// Mirror of apps/web/lib/ssrf.ts — the ws app POSTs bot webhook updates and
// needs the same guard. The forbidden-range list lives once in @legends/shared
// (isBlockedIp); only the node:dns glue is duplicated (can't live in shared,
// which is also bundled client-side).
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

async function assertPublicHttpsUrl(raw: string): Promise<void> {
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

export async function safeWebhookFetch(url: string, init: RequestInit): Promise<Response> {
  await assertPublicHttpsUrl(url);
  return fetch(url, { ...init, redirect: "manual" });
}
