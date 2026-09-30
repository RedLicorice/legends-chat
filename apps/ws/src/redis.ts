import { Redis } from "ioredis";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * #rt-3 — Redis is not a cache here, it is the transport.
 *
 * Everything the realtime layer fans out crosses it: full message plaintext
 * (BOT_MESSAGE_NEW), full DM plaintext for non-E2EE conversations, every
 * Socket.IO broadcast via the adapter, the topic-password proof keys and the
 * revoked-jti blocklist, plus control events — USER_BANNED force-disconnects a
 * user, SESSION_REVOKED ends a session, NOTIFICATION_BROADCAST reaches every
 * account. There is no publisher authentication or signing on any of it, so
 * anyone who can reach an unauthenticated Redis can passively read all
 * non-E2EE traffic AND inject forged control events.
 *
 * So refuse to boot in production against a Redis that is unauthenticated, or
 * reachable off-host without TLS. Development keeps the bundled localhost
 * instance from docker-compose.yml.
 */
function assertProdRedisUrl(raw: string): void {
  if (process.env.NODE_ENV !== "production") return;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("REDIS_URL is not a valid URL — refusing to start");
  }

  if (!u.password) {
    throw new Error(
      "REDIS_URL has no password — refusing to start. All chat and DM traffic, " +
        "session revocations and force-disconnect events cross this connection. " +
        "Use redis://default:<password>@host:6379 (or rediss:// off-host).",
    );
  }

  // Only the loopback interface counts as local. A container-network service
  // name such as "redis" is still a hop across a network we do not control.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!isLoopback && u.protocol !== "rediss:") {
    throw new Error(
      `REDIS_URL points at a non-local host (${u.hostname}) over plaintext — refusing to start. ` +
        "Use rediss:// so the traffic is TLS-protected in transit.",
    );
  }
}

assertProdRedisUrl(url);

export const pubClient = new Redis(url, { maxRetriesPerRequest: null });
export const subClient = pubClient.duplicate();
export const cacheClient = pubClient.duplicate();
