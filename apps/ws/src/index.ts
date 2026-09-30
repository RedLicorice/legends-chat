import { createServer } from "node:http";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { Server, type Socket, type DefaultEventsMap } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { users, topicPrincipalGrants, rolesPermissions, principalPermissionOverrides } from "@legends/db/schema";
import { db } from "./db";
import { cacheClient } from "./redis";

const ONLINE_KEY = "legends:online";
const PRESENCE_TTL = 90; // seconds — heartbeat keeps it alive

async function isPresenceOptOut(userId: string): Promise<boolean> {
  const [u] = await db.select({ presenceOptOut: users.presenceOptOut }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.presenceOptOut ?? false;
}

async function markOnline(userId: string): Promise<void> {
  await cacheClient.sadd(ONLINE_KEY, userId);
  await cacheClient.expire(ONLINE_KEY, PRESENCE_TTL * 10);
}

async function markOffline(userId: string): Promise<void> {
  await cacheClient.srem(ONLINE_KEY, userId);
}

async function getOnlineUsers(): Promise<string[]> {
  return cacheClient.smembers(ONLINE_KEY);
}

const PRESENCE_CONNS_KEY = (userId: string) => `legends:presence:conns:${userId}`;

// PRESENCE_UPDATE is a GLOBAL broadcast to every connected socket, so firing it
// on every connect/disconnect makes each extra tab another cluster-wide fan-out
// (#rt-6). Track a user's open sockets in a Redis set and broadcast only on the
// 0→1 and 1→0 transitions. The set carries a TTL so socket ids orphaned by a
// crashed replica expire instead of pinning the user "online" forever.
async function addPresenceConn(userId: string, socketId: string): Promise<boolean> {
  const key = PRESENCE_CONNS_KEY(userId);
  await cacheClient.sadd(key, socketId);
  await cacheClient.expire(key, PRESENCE_TTL * 10);
  return (await cacheClient.scard(key)) === 1;
}

async function removePresenceConn(userId: string, socketId: string): Promise<boolean> {
  const key = PRESENCE_CONNS_KEY(userId);
  await cacheClient.srem(key, socketId);
  return (await cacheClient.scard(key)) === 0;
}

async function loadLinkProcessorSettings(): Promise<LinkProcessorSettings> {
  const s = await getAllSettings(db);
  return {
    shlinkEnabled: s.shlink_enabled === "true",
    shlinkHost: s.shlink_host?.trim() || null,
    shlinkApiKey: s.shlink_api_key?.trim() || null,
    shlinkDefaultDomain: s.shlink_default_domain?.trim() || null,
    shlinkTagWithUser: s.shlink_tag_with_user === "true",
    shlinkWrapRegex: s.shlink_wrap_regex?.trim() || null,
    stripTracking: s.strip_tracking_params === "true",
    publicOrigin: process.env.APP_PUBLIC_URL ?? null,
  };
}

async function maybeProcessLinks(text: string, senderUserId: string | null): Promise<string> {
  if (!text || !text.trim()) return text;
  try {
    const cfg = await loadLinkProcessorSettings();
    if (!cfg.stripTracking && !cfg.shlinkEnabled) return text;
    return await processMessageLinks(text, cfg, senderUserId);
  } catch (e) {
    log.error("link-processor failed", e);
    return text;
  }
}
import {
  PERMISSIONS,
  REDIS_CHANNELS,
  WS_EVENTS,
  createLogger,
  createPollSchema,
  messageDeleteSchema,
  messageEditSchema,
  pollCloseSchema,
  pollVoteSchema,
  reactionToggleSchema,
  resolvePermissions,
  sendMessageSchema,
  topicReadSchema,
  stripMarkdownPreview,
  canPrincipal,
  processMessageLinks,
  type LinkProcessorSettings,
  type AccessTokenPayload,
  type TopicGrant,
  type GrantEffect,
} from "@legends/shared";
import { getAllSettings } from "@legends/db/system-settings";
import { authenticateSocket, reauthenticateSocket } from "./socket-auth";
import { buildSessionBootstrap, buildTopicBootstrap } from "./bootstrap";
import { pubClient, subClient } from "./redis";
import { runAsLeader } from "./leader-lock";
import { purgeCountModeForTopic, startAutoDelete } from "./autodelete";
import { getTopicAutoDelete } from "./messages";
import { notifyTopicMembers } from "./push";
import {
  castPollVote,
  closePollById,
  createPollMessage,
  editMessage,
  ensureTopicMembership,
  getMessageOwner,
  getMessageTopicId,
  messageKeyboardHasCallback,
  getMyPollVotes,
  insertMessage,
  isUserMuted,
  listReactionsForTopic,
  listRecentMessages,
  setLastReadMessage,
  softDeleteMessage,
  toggleReaction,
  getTopicById,
  getTopicMemberUserIds,
  filterUsersWhoCanViewTopic,
  userCanAccessTopic,
  getPollTopicId,
} from "./messages";
import { deliverCallbackQueryToWebhooks, deliverMessageToWebhooks, deliverNewMemberToWebhooks } from "./webhook";
import { dispatchMessageNotifications } from "./notifications";
import { registerP2PHandlers } from "./p2p-signaling";
import { isRateLimited } from "./rate-limit";
import { randomUUID } from "node:crypto";

const log = createLogger("ws");

interface SocketData {
  user: AccessTokenPayload;
}
type AuthedSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("legends-chat ws ok\n");
});

const allowedOrigins = [
  process.env.WEB_URL,
  process.env.APP_PUBLIC_URL,
  // Dev-only convenience origin — never trust localhost in production.
  process.env.NODE_ENV !== "production" ? "http://localhost:3000" : null,
].filter(Boolean) as string[];

// #rt-8: docker-compose.prod.yml sets APP_PUBLIC_URL but not WEB_URL, and
// nothing checked the result — if neither were set the list silently became []
// and the only thing left standing between a cross-site page and an
// authenticated socket was SameSite=Lax suppressing the cookie. Fail loudly.
if (process.env.NODE_ENV === "production" && allowedOrigins.length === 0) {
  throw new Error(
    "No WS origin allow-list — set APP_PUBLIC_URL (or WEB_URL). Refusing to start: " +
      "every browser handshake would be rejected and cross-site origin checks would have nothing to compare against.",
  );
}

const allowedOriginSet = new Set(
  allowedOrigins.map((o) => {
    try { return new URL(o).origin; } catch { return o; }
  }),
);

/**
 * #rt-8: Socket.IO's `cors` option only governs the HTTP polling handshake —
 * a native WebSocket upgrade never consults it, so CORS is not an auth control
 * here. Check Origin explicitly, as a precondition of authentication.
 *
 * A browser ALWAYS sends Origin on a WebSocket handshake, so a missing Origin
 * is a non-browser client (health check, server-side bot), not the CSWSH case;
 * present-but-foreign is. Today SameSite=Lax also suppresses the cookie
 * cross-site, but that is one implicit control carrying an auth decision — this
 * is the explicit one.
 */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return allowedOriginSet.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

/**
 * #rt-9: the ws layer had no notion of a client IP at all, so every limiter was
 * keyed on user.sub only — and anonymous sessions are a supported feature, so
 * minting N accounts buys N copies of every budget. Mirrors the derivation in
 * apps/web/lib/rate-limit.ts: CF-Connecting-IP is set at the edge and
 * overwrites anything the client sent; X-Forwarded-For's LEADING entry is
 * client-controlled (nginx appends the real peer at the END), so read the last.
 * Requires the header forwarding added to nginx's /socket.io/ location.
 */
function handshakeIp(headers: Record<string, string | string[] | undefined>, fallback: string): string {
  const first = (v: string | string[] | undefined): string | undefined =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  const cf = first(headers["cf-connecting-ip"]);
  if (cf) return cf;
  const real = first(headers["x-real-ip"]);
  if (real) return real;
  const xff = first(headers["x-forwarded-for"]);
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1]!;
  }
  return fallback || "unknown";
}

const io = new Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

io.adapter(createAdapter(pubClient, subClient));

io.use(async (socket, next) => {
  try {
    // Origin is an auth PRECONDITION (#rt-8) — checked before the cookie is
    // even parsed, and on the upgrade path that `cors` above never reaches.
    const origin = socket.handshake.headers.origin;
    if (!originAllowed(origin)) {
      log.warn("handshake rejected: disallowed origin", { origin });
      next(new Error("origin not allowed"));
      return;
    }
    // IP-keyed handshake budget (#rt-9), before any DB/JWT work so a flood is
    // shed cheaply. Sits alongside — not instead of — the per-user budgets.
    const ip = handshakeIp(socket.handshake.headers, socket.handshake.address);
    if (await isRateLimited(`ws:handshake:ip:${ip}`, 120, 60)) {
      log.warn("handshake rejected: ip rate limit", { ip });
      next(new Error("too many connections"));
      return;
    }
    socket.data.user = await authenticateSocket(socket);
    // Per-account connection churn cap, so one account cannot loop handshakes
    // from many IPs either.
    if (await isRateLimited(`ws:handshake:user:${socket.data.user.sub}`, 60, 60)) {
      next(new Error("too many connections"));
      return;
    }
    next();
  } catch (err) {
    next(err instanceof Error ? err : new Error("auth failed"));
  }
});

const MOD_ROOM = "mod:queue";

interface UserAuthz {
  role: string;
  permissions: string[];
}

// Authoritative role + resolved permission set, straight from the DB. The JWT
// only carries the snapshot taken when it was minted, and a socket holds that
// snapshot for its whole life (#rt-1) — so a demotion, a revoked override or a
// deleted account would otherwise never reach an open connection.
// role → permissions, memoized briefly. The sweeper below re-resolves authz for
// every live socket on every tick, and this lookup is identical for every user
// sharing a role; the per-user rows are always read fresh. TTL is short enough
// that a role's permission set still takes effect within one sweep interval.
const ROLE_PERMS_TTL_MS = 30_000;
const rolePermsCache = new Map<string, { at: number; perms: string[] }>();

async function permissionsForRole(role: string): Promise<string[]> {
  const hit = rolePermsCache.get(role);
  if (hit && Date.now() - hit.at < ROLE_PERMS_TTL_MS) return hit.perms;
  const rows = await db
    .select({ permission: rolesPermissions.permission })
    .from(rolesPermissions)
    .where(eq(rolesPermissions.role, role));
  const perms = rows.map((p) => p.permission);
  rolePermsCache.set(role, { at: Date.now(), perms });
  return perms;
}

async function loadUserAuthz(userId: string): Promise<UserAuthz | null> {
  const now = new Date();
  const [userRows, overrideRows] = await Promise.all([
    db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1),
    db.select({ permission: principalPermissionOverrides.permission, effect: principalPermissionOverrides.effect })
      .from(principalPermissionOverrides)
      .where(
        and(
          eq(principalPermissionOverrides.principalType, "user"),
          eq(principalPermissionOverrides.principalId, userId),
          or(isNull(principalPermissionOverrides.expiresAt), gt(principalPermissionOverrides.expiresAt, now)),
        ),
      ),
  ]);
  const role = userRows[0]?.role;
  if (!role) return null; // account deleted while the socket was open
  const set = resolvePermissions(
    await permissionsForRole(role),
    overrideRows as { permission: string; effect: "allow" | "deny" }[],
  );
  return { role, permissions: [...set] };
}

/**
 * Re-reads this socket's role/permissions from the DB and re-syncs its mod-room
 * membership. Returns false when the account no longer exists (caller drops the
 * socket).
 *
 * MUTATES socket.data.user in place — every event handler below closes over
 * that one object reference, so an in-place update is exactly what makes a
 * demotion visible to already-registered listeners. Replacing the object would
 * leave every handler reading the stale snapshot.
 */
async function syncSocketAuthz(socket: AuthedSocket): Promise<boolean> {
  const user = socket.data.user;
  const authz = await loadUserAuthz(user.sub);
  if (!authz) return false;
  const changed =
    authz.role !== user.role ||
    authz.permissions.length !== user.permissions.length ||
    authz.permissions.some((p) => !user.permissions.includes(p));
  user.role = authz.role;
  user.permissions = authz.permissions;
  if (authz.permissions.includes(PERMISSIONS.MODERATION_QUEUE_REVIEW)) socket.join(MOD_ROOM);
  else socket.leave(MOD_ROOM);
  if (changed) {
    log.info("socket authz refreshed from db", { userId: user.sub, role: authz.role });
  }
  return true;
}

function dropSocket(socket: AuthedSocket, reason: string): void {
  log.info("re-auth: closing socket", { userId: socket.data.user?.sub, reason });
  socket.emit("error", { message: "unauthorized" });
  socket.disconnect(true);
}

// How often a live socket's token + authz are checked again. Bounds how long a
// logout / demotion can outlive the change when the SESSION_REVOKED signal is
// missed (e.g. the web app could not reach Redis).
const REAUTH_INTERVAL_MS = Number(process.env.WS_REAUTH_INTERVAL_MS ?? 30_000);

// Sweeps only THIS replica's sockets (io.sockets.sockets is local); every
// replica runs its own timer, so the whole cluster is covered.
async function reverifyConnectedSockets(): Promise<void> {
  for (const socket of io.sockets.sockets.values()) {
    const s = socket as AuthedSocket;
    if (!s.connected || !s.data.user) continue;
    const res = await reauthenticateSocket(s);
    // Fail open on an infrastructure error — a Redis blip must not drop every
    // connection at once. The next sweep decides.
    if (res.status === "unavailable") continue;
    if (res.status === "rejected") {
      dropSocket(s, res.reason);
      continue;
    }
    try {
      if (!(await syncSocketAuthz(s))) dropSocket(s, "account no longer exists");
    } catch (err) {
      log.error("re-auth: authz reload failed", err);
    }
  }
}

let reauthSweeping = false;
const reauthTimer = setInterval(() => {
  if (reauthSweeping) return;
  reauthSweeping = true;
  reverifyConnectedSockets()
    .catch((err) => log.error("re-auth sweep failed", err))
    .finally(() => { reauthSweeping = false; });
}, REAUTH_INTERVAL_MS);
reauthTimer.unref();

io.on("connection", async (socket: AuthedSocket) => {
  const user = socket.data.user;
  socket.join(`user:${user.sub}`);
  // Re-resolve role/permissions from the DB (the token only carries a snapshot)
  // and join/leave MOD_ROOM accordingly. Deliberately not awaited: an await here
  // would delay handler registration and drop events a fast client sends first.
  syncSocketAuthz(socket)
    .then((ok) => { if (!ok) dropSocket(socket, "account no longer exists"); })
    .catch((err) => log.error("authz sync failed", err));
  registerP2PHandlers(io, socket);

  // Track online presence (skip if user opted out)
  const optOut = await isPresenceOptOut(user.sub).catch(() => false);
  if (!optOut) {
    // Only the user's FIRST live socket flips them online (#rt-6).
    const isFirstConn = await addPresenceConn(user.sub, socket.id).catch(() => true);
    if (isFirstConn) {
      await markOnline(user.sub).catch(() => {});
      // Broadcast to all rooms this user is in
      socket.broadcast.emit(WS_EVENTS.PRESENCE_UPDATE, { userId: user.sub, online: true });
    }
  }

  // Once-per-connect global bootstrap. Symbols / VAPID / notifications /
  // mod-flag count rarely change, so a single push at connect saves four
  // REST round trips on every page open. Live deltas keep these fresh.
  buildSessionBootstrap(user)
    .then((payload) => { socket.emit(WS_EVENTS.SESSION_BOOTSTRAP, payload); })
    .catch((err) => { log.error("session-bootstrap failed", err); });

  socket.on("disconnect", async () => {
    if (!optOut) {
      // ...and only the LAST one flips them offline (#rt-6).
      const wasLastConn = await removePresenceConn(user.sub, socket.id).catch(() => true);
      if (wasLastConn) {
        await markOffline(user.sub).catch(() => {});
        io.emit(WS_EVENTS.PRESENCE_UPDATE, { userId: user.sub, online: false });
      }
    }
  });

  socket.on(WS_EVENTS.TOPIC_JOIN, async (slugOrId: string, ack?: (res: unknown) => void) => {
    try {
      // The most expensive event in the app (~8 queries, one of them an
      // unnest+GROUP BY hashtag aggregate) and it also emits the E2EE
      // key-rotation signal to every viewer on a first join — a join/rejoin loop
      // is both DB exhaustion and a forced Megolm discard-and-reshare (#rt-6).
      if (await isRateLimited(`ws:topic-join:${user.sub}`, 30, 10)) {
        ack?.({ ok: false, error: "RATE_LIMITED" });
        return;
      }
      const bootstrap = await buildTopicBootstrap(user, slugOrId);
      if (!bootstrap.ok) { ack?.({ ok: false, error: bootstrap.error }); return; }
      const topicId = bootstrap.topicId;
      await ensureTopicMembership(user.sub, topicId);
      socket.join(`topic:${topicId}`);
      const [recent, reactions, onlineIds] = await Promise.all([
        listRecentMessages(topicId, 50, user.sub),
        listReactionsForTopic(topicId, 50),
        optOut ? Promise.resolve([]) : getOnlineUsers(),
      ]);
      const pollIds = recent.filter((m) => m.poll).map((m) => m.poll!.id);
      const myPollVotes = await getMyPollVotes(user.sub, pollIds);
      // `data` carries the TopicBootstrap that replaces the seven per-nav
      // REST round trips. The legacy fields (messages/reactions/etc) ride
      // along — they were never part of those round trips, just the
      // existing socket join ack.
      ack?.({
        ok: true,
        data: bootstrap.data,
        messages: recent,
        reactions,
        onlineUserIds: optOut ? [] : onlineIds,
        myPollVotes,
      });
    } catch (err) {
      ack?.({ ok: false, error: "error", detail: (err as Error).message });
    }
  });

  socket.on(WS_EVENTS.TOPIC_LEAVE, (topicId: string) => {
    socket.leave(`topic:${topicId}`);
  });

  socket.on(WS_EVENTS.MESSAGE_SEND, async (raw: unknown, ack?: (res: unknown) => void) => {
    try {
      // Flood guard FIRST — shed spam before any DB work (mute lookup, topic
      // fetch, grant query, insert). 30 messages / 10s per user ≈ 3/s sustained,
      // generous for humans, fatal to a flood loop.
      if (await isRateLimited(`ws:send:${user.sub}`, 30, 10)) {
        ack?.({ ok: false, error: "RATE_LIMITED" });
        return;
      }
      const parsed = sendMessageSchema.parse(raw);
      // Topic view gate FIRST (#rt-2). canPrincipal below defaults OPEN when the
      // topic's postRoles list is empty, so without this any authenticated user
      // could post into a topic they cannot even open — and trigger its whole
      // fan-out (MESSAGE_NEW, SIDEBAR_UPDATE, push, webhooks) — just by naming
      // its id on a raw message:send. Room membership is not enough: the handler
      // never required the sender to have joined.
      if (!(await userCanAccessTopic(user.sub, user.role, parsed.topicId))) {
        ack?.({ ok: false, error: "FORBIDDEN" });
        return;
      }
      const muted = await isUserMuted(user.sub);
      if (muted) {
        ack?.({ ok: false, error: "MUTED", reason: muted.reason, expiresAt: muted.expiresAt });
        return;
      }
      const topic = await getTopicById(parsed.topicId);
      // Enforce post/reply permission
      const now = new Date();
      const grantRows = await db
        .select({ action: topicPrincipalGrants.action, effect: topicPrincipalGrants.effect })
        .from(topicPrincipalGrants)
        .where(
          and(
            eq(topicPrincipalGrants.topicId, parsed.topicId),
            eq(topicPrincipalGrants.principalType, "user"),
            eq(topicPrincipalGrants.principalId, user.sub),
            or(isNull(topicPrincipalGrants.expiresAt), gt(topicPrincipalGrants.expiresAt, now)),
          ),
        );
      const grants: TopicGrant[] = grantRows.map((g) => ({ action: g.action, effect: g.effect as GrantEffect }));
      const isReply = !!(parsed.content?.replyToMessageId);
      const actionRoles = isReply && topic?.isFeed
        ? ((topic?.replyRoles as string[] | null) ?? [])
        : ((topic?.postRoles as string[] | null) ?? []);
      const action = isReply && topic?.isFeed ? "reply" : "post";
      if (!canPrincipal(grants, actionRoles, user.role, action)) {
        ack?.({ ok: false, error: "FORBIDDEN" });
        return;
      }
      const isE2ee = topic?.isE2ee ?? false;
      const hasCipher = !!parsed.content.ciphertextJson;
      // Branch-coherence checks: E2EE topics MUST carry ciphertextJson; plain
      // topics must NOT. The zod schema already enforces text↔cipher XOR
      // within the payload; here we just bind it to the topic's flag.
      if (isE2ee && !hasCipher) {
        ack?.({ ok: false, error: "E2EE topic; send ciphertext" });
        return;
      }
      if (!isE2ee && hasCipher) {
        ack?.({ ok: false, error: "topic is not E2EE; send plaintext" });
        return;
      }
      // Link processing (strip tracking / shlink wrap). Skipped for E2EE
      // topics — the client calls /api/links/process before encrypting. Server
      // can't read ciphertext.
      const processedText = isE2ee
        ? parsed.content.text
        : await maybeProcessLinks(parsed.content.text, user.sub);
      const incomingHashtags = parsed.hashtags ?? [];
      const validHashtags = incomingHashtags
        .filter((t) => /^[#$][a-zA-Z]\w*$/.test(t))
        .slice(0, 20);
      const msg = await insertMessage({
        topicId: parsed.topicId,
        senderUserId: user.sub,
        text: processedText,
        attachments: parsed.content.attachments as import("./messages").MessageAttachment[] | undefined,
        replyToMessageId: parsed.content.replyToMessageId ?? null,
        searchText: isE2ee ? undefined : processedText,
        hashtags: validHashtags,
        ciphertextJson: parsed.content.ciphertextJson ?? null,
      });
      io.to(`topic:${parsed.topicId}`).emit(WS_EVENTS.MESSAGE_NEW, msg);
      ack?.({ ok: true, message: msg });
      // `plainPreview` is reused for push notifications + the in-app
      // notification fanout, which still want *some* user-visible string for
      // E2EE topics (where the server has no plaintext). The sidebar payload
      // below ships an empty preview instead so the chat list never renders a
      // "(encrypted message)" placeholder.
      const plainPreview = isE2ee ? "(encrypted message)" : stripMarkdownPreview(processedText, topic?.isFeed ?? false);
      const sidebarPreview = isE2ee ? "" : plainPreview;
      // Broadcast sidebar update to all topic members so their sidebar refreshes in real time
      getTopicMemberUserIds(parsed.topicId)
        // #rt-5: membership is written on first join and never removed on a
        // demotion or when the topic later becomes restricted, so the raw member
        // list leaks a message preview to people who can no longer open it.
        .then((ids) => filterUsersWhoCanViewTopic(parsed.topicId, ids))
        .then((memberIds) => {
          const sidebarPayload = {
            topicId: parsed.topicId,
            preview: sidebarPreview,
            senderId: user.sub,
            senderName: msg.senderDisplayName ?? null,
            at: typeof msg.createdAt === "string" ? msg.createdAt : (msg.createdAt as Date).toISOString(),
          };
          for (const memberId of memberIds) {
            io.to(`user:${memberId}`).emit(WS_EVENTS.SIDEBAR_UPDATE, sidebarPayload);
          }
        })
        .catch((e) => log.error("sidebar broadcast failed", e));
      if (validHashtags.length > 0) {
        io.to(`topic:${parsed.topicId}`).emit(WS_EVENTS.HASHTAG_CLOUD_UPDATE, {
          topicId: parsed.topicId,
          tags: validHashtags,
        });
      }
      dispatchMessageNotifications(io, {
        messageId: msg.id,
        topicId: parsed.topicId,
        topicSlug: topic?.slug ?? "",
        topicTitle: topic?.title ?? "",
        senderUserId: user.sub,
        senderName: msg.senderDisplayName ?? "Unknown",
        text: plainPreview,
        replyToMessageId: parsed.content.replyToMessageId ?? null,
      }).catch((e) => log.error("notifications dispatch failed", e));
      if (!isE2ee) {
        deliverMessageToWebhooks(parsed.topicId, topic?.title ?? "", msg).catch((e) =>
          log.error("webhook delivery failed", e),
        );
      }
      notifyTopicMembers({
        topicId: parsed.topicId,
        senderUserId: user.sub,
        preview: plainPreview,
        messageId: msg.id,
      }).catch((e) => log.error("push notify failed", e));
      const cfg = await getTopicAutoDelete(parsed.topicId);
      if (cfg?.mode === "count" && cfg.max) {
        purgeCountModeForTopic(io, parsed.topicId, cfg.max).catch((e) =>
          log.error("autodelete count purge failed", e),
        );
      }
    } catch (err) {
      ack?.({ ok: false, error: (err as Error).message });
    }
  });

  socket.on(WS_EVENTS.TOPIC_READ, async (raw: unknown) => {
    try {
      // One DB write per event — throttle it (#rt-6).
      if (await isRateLimited(`ws:topic-read:${user.sub}`, 60, 10)) return;
      const parsed = topicReadSchema.parse(raw);
      if (!(await userCanAccessTopic(user.sub, user.role, parsed.topicId))) return; // #18/#rt-2 authz
      await setLastReadMessage(user.sub, parsed.topicId, parsed.lastReadMessageId);
    } catch (err) {
      log.error("topic:read failed", err);
    }
  });

  socket.on(WS_EVENTS.POLL_CREATE, async (raw: unknown, ack?: (res: unknown) => void) => {
    try {
      if (await isRateLimited(`ws:poll-create:${user.sub}`, 10, 60)) {
        ack?.({ ok: false, error: "RATE_LIMITED" }); return;
      }
      if (user.role === "user") {
        ack?.({ ok: false, error: "Insufficient permissions" });
        return;
      }
      const parsed = createPollSchema.parse(raw);
      // #rt-2: this handler had no topic gate at all — the role check above let
      // any non-"user" account drop a poll into any topic in the deployment.
      if (!(await userCanAccessTopic(user.sub, user.role, parsed.topicId))) {
        ack?.({ ok: false, error: "FORBIDDEN" }); return;
      }
      const muted = await isUserMuted(user.sub);
      if (muted) { ack?.({ ok: false, error: "MUTED" }); return; }
      const msg = await createPollMessage({
        topicId: parsed.topicId,
        createdByUserId: user.sub,
        question: parsed.question,
        options: parsed.options,
        isAnonymous: parsed.isAnonymous,
        allowsMultiple: parsed.allowsMultiple,
      });
      io.to(`topic:${parsed.topicId}`).emit(WS_EVENTS.MESSAGE_NEW, msg);
      ack?.({ ok: true, message: msg });
    } catch (err) {
      ack?.({ ok: false, error: (err as Error).message });
    }
  });

  socket.on(WS_EVENTS.POLL_VOTE, async (raw: unknown, ack?: (res: unknown) => void) => {
    try {
      if (await isRateLimited(`ws:poll-vote:${user.sub}`, 30, 10)) {
        ack?.({ ok: false, error: "RATE_LIMITED" }); return;
      }
      const parsed = pollVoteSchema.parse(raw);
      const voteTopicId = await getPollTopicId(parsed.pollId); // #18/#rt-2 authz
      if (!voteTopicId || !(await userCanAccessTopic(user.sub, user.role, voteTopicId))) {
        ack?.({ ok: false, error: "FORBIDDEN" }); return;
      }
      const result = await castPollVote({ pollId: parsed.pollId, userId: user.sub, optionIds: parsed.optionIds });
      if (!result.ok) { ack?.({ ok: false, error: result.error }); return; }
      if (result.pollData?.topicId) {
        io.to(`topic:${result.pollData.topicId}`).emit(WS_EVENTS.POLL_UPDATED, {
          pollId: parsed.pollId,
          options: result.pollData.options,
          totalVotes: result.pollData.totalVotes,
          isClosed: result.pollData.isClosed,
        });
      }
      ack?.({ ok: true, myVotes: result.myVotes });
    } catch (err) {
      ack?.({ ok: false, error: (err as Error).message });
    }
  });

  socket.on(WS_EVENTS.POLL_CLOSE, async (raw: unknown, ack?: (res: unknown) => void) => {
    try {
      if (await isRateLimited(`ws:poll-close:${user.sub}`, 20, 60)) { // #rt-6
        ack?.({ ok: false, error: "RATE_LIMITED" }); return;
      }
      if (user.role === "user") { ack?.({ ok: false, error: "Insufficient permissions" }); return; }
      const parsed = pollCloseSchema.parse(raw);
      // #rt-2: no topic gate at all before this — any non-"user" account could
      // close any poll in the deployment, including in topics it cannot open.
      const closeTopicId = await getPollTopicId(parsed.pollId);
      if (!closeTopicId || !(await userCanAccessTopic(user.sub, user.role, closeTopicId))) {
        ack?.({ ok: false, error: "FORBIDDEN" }); return;
      }
      const result = await closePollById(parsed.pollId);
      if (result.pollData?.topicId) {
        io.to(`topic:${result.pollData.topicId}`).emit(WS_EVENTS.POLL_UPDATED, {
          pollId: parsed.pollId,
          options: result.pollData.options,
          totalVotes: result.pollData.totalVotes,
          isClosed: true,
        });
      }
      ack?.({ ok: true });
    } catch (err) {
      ack?.({ ok: false, error: (err as Error).message });
    }
  });

  socket.on(WS_EVENTS.REACTION_TOGGLE, async (raw: unknown, ack?: (res: unknown) => void) => {
    try {
      if (await isRateLimited(`ws:react:${user.sub}`, 60, 10)) {
        ack?.({ ok: false, error: "RATE_LIMITED" }); return;
      }
      const parsed = reactionToggleSchema.parse(raw);
      const muted = await isUserMuted(user.sub);
      if (muted) {
        ack?.({ ok: false, error: "MUTED", reason: muted.reason, expiresAt: muted.expiresAt });
        return;
      }
      const topicId = await getMessageTopicId(parsed.messageId);
      if (!topicId) {
        ack?.({ ok: false, error: "message not found" });
        return;
      }
      if (!(await userCanAccessTopic(user.sub, user.role, topicId))) { // #18/#rt-2 authz
        ack?.({ ok: false, error: "FORBIDDEN" });
        return;
      }
      const result = await toggleReaction({
        messageId: parsed.messageId,
        userId: user.sub,
        emojiKey: parsed.emojiKey,
      });
      const event = result.added ? WS_EVENTS.REACTION_ADD : WS_EVENTS.REACTION_REMOVE;
      io.to(`topic:${topicId}`).emit(event, {
        messageId: parsed.messageId,
        userId: user.sub,
        emojiKey: parsed.emojiKey,
      });
      ack?.({ ok: true, ...result });
    } catch (err) {
      ack?.({ ok: false, error: (err as Error).message });
    }
  });

  socket.on(WS_EVENTS.MESSAGE_EDIT_REQ, async (raw: unknown, ack?: (res: unknown) => void) => {
    try {
      if (await isRateLimited(`ws:edit:${user.sub}`, 20, 10)) {
        ack?.({ ok: false, error: "RATE_LIMITED" }); return;
      }
      const parsed = messageEditSchema.parse(raw);
      // #rt-2: topic gate before anything else — editing is a write into a
      // topic, so it needs the same access proof as reading it.
      if (!(await userCanAccessTopic(user.sub, user.role, parsed.topicId))) {
        ack?.({ ok: false, error: "FORBIDDEN" }); return;
      }
      const owner = await getMessageOwner(parsed.messageId);
      if (!owner || owner.topicId !== parsed.topicId) {
        ack?.({ ok: false, error: "not found" }); return;
      }
      const isOwn = owner.senderUserId === user.sub;
      // Real permission, not `role !== "user"`: that shorthand handed edit-anything
      // to every custom role in the deployment regardless of what it was granted.
      // socket.data.user.permissions is kept in sync with the DB by the re-auth
      // sweeper (#rt-1), so a revoked grant lands here too.
      const canEditAny = user.permissions.includes(PERMISSIONS.MESSAGES_EDIT_ANY);
      const canEditOwn = user.permissions.includes(PERMISSIONS.MESSAGES_EDIT_OWN);
      if (isOwn ? !(canEditOwn || canEditAny) : !canEditAny) {
        ack?.({ ok: false, error: "forbidden" }); return;
      }
      // Branch must match topic.isE2ee — client encrypts via Megolm for E2EE,
      // sends plaintext for plain topics. Reject crossed wires.
      const editTopic = await getTopicById(parsed.topicId);
      const topicE2ee = editTopic?.isE2ee ?? false;
      if (topicE2ee) {
        if (!parsed.ciphertextJson) {
          ack?.({ ok: false, error: "E2EE topic requires ciphertextJson" }); return;
        }
        const updated = await editMessage({
          messageId: parsed.messageId,
          topicId: parsed.topicId,
          newCiphertextJson: parsed.ciphertextJson,
          editedByUserId: user.sub,
        });
        if (!updated) { ack?.({ ok: false, error: "message not found or deleted" }); return; }
        io.to(`topic:${parsed.topicId}`).emit(WS_EVENTS.MESSAGE_EDIT, updated);
        ack?.({ ok: true });
        return;
      }
      // Plain-topic path
      if (parsed.text === undefined) {
        ack?.({ ok: false, error: "plain topic requires text" }); return;
      }
      const editText = await maybeProcessLinks(parsed.text, user.sub);
      const updated = await editMessage({
        messageId: parsed.messageId,
        topicId: parsed.topicId,
        newText: editText,
        editedByUserId: user.sub,
      });
      if (!updated) { ack?.({ ok: false, error: "message not found or deleted" }); return; }
      io.to(`topic:${parsed.topicId}`).emit(WS_EVENTS.MESSAGE_EDIT, updated);
      ack?.({ ok: true });
    } catch (err) {
      ack?.({ ok: false, error: (err as Error).message });
    }
  });

  socket.on(WS_EVENTS.MESSAGE_DELETE_REQ, async (raw: unknown, ack?: (res: unknown) => void) => {
    try {
      if (await isRateLimited(`ws:delete:${user.sub}`, 20, 10)) { // #rt-6
        ack?.({ ok: false, error: "RATE_LIMITED" }); return;
      }
      const parsed = messageDeleteSchema.parse(raw);
      if (!(await userCanAccessTopic(user.sub, user.role, parsed.topicId))) { // #rt-2
        ack?.({ ok: false, error: "FORBIDDEN" }); return;
      }
      const owner = await getMessageOwner(parsed.messageId);
      if (!owner || owner.topicId !== parsed.topicId) {
        ack?.({ ok: false, error: "not found" }); return;
      }
      const isOwn = owner.senderUserId === user.sub;
      // See MESSAGE_EDIT_REQ — real permission, not the `role !== "user"` shorthand.
      const canDeleteAny = user.permissions.includes(PERMISSIONS.MESSAGES_DELETE_ANY);
      const canDeleteOwn = user.permissions.includes(PERMISSIONS.MESSAGES_DELETE_OWN);
      if (isOwn ? !(canDeleteOwn || canDeleteAny) : !canDeleteAny) {
        ack?.({ ok: false, error: "forbidden" }); return;
      }
      await softDeleteMessage(parsed.messageId, parsed.topicId);
      io.to(`topic:${parsed.topicId}`).emit(WS_EVENTS.MESSAGE_DELETE, { id: parsed.messageId, topicId: parsed.topicId });
      ack?.({ ok: true });
    } catch (err) {
      ack?.({ ok: false, error: (err as Error).message });
    }
  });

  socket.on(WS_EVENTS.BOT_KEYBOARD_CALLBACK, async (raw: unknown, ack?: (res: unknown) => void) => {
    try {
      // Each callback is an outbound HTTP POST to a bot webhook plus a Redis
      // rpush — unthrottled outbound-request amplification otherwise (#rt-6).
      if (await isRateLimited(`ws:bot-callback:${user.sub}`, 30, 60)) {
        ack?.({ ok: false, error: "RATE_LIMITED" }); return;
      }
      const { botId, messageId, callbackData } = raw as { botId: string; messageId: string; callbackData: string };
      if (
        typeof botId !== "string" || typeof messageId !== "string" || typeof callbackData !== "string" ||
        !botId || !messageId || !callbackData || callbackData.length > 256
      ) { ack?.({ ok: false, error: "invalid payload" }); return; }
      const topicId = await getMessageTopicId(messageId);
      if (!topicId) { ack?.({ ok: false, error: "message not found" }); return; }
      if (!(await userCanAccessTopic(user.sub, user.role, topicId))) { // #18/#rt-2 authz
        ack?.({ ok: false, error: "FORBIDDEN" }); return;
      }
      // #rt-7: callbackData is client-supplied. Without this, a user who can see
      // any one topic could synthesize arbitrary callback payloads into bot
      // logic. Only a button that really exists on this message's stored inline
      // keyboard may be pressed.
      if (!(await messageKeyboardHasCallback(messageId, callbackData))) {
        ack?.({ ok: false, error: "unknown callback" }); return;
      }
      const callbackQueryId = randomUUID();
      ack?.({ ok: true, callbackQueryId });
      deliverCallbackQueryToWebhooks(topicId, botId, callbackQueryId, messageId, user.sub, null, callbackData)
        .catch((e) => log.error("webhook callback delivery failed", e));
    } catch (err) {
      ack?.({ ok: false, error: (err as Error).message });
    }
  });
});

// React to ban/mute pubsub from the web app: force-disconnect affected users.
subClient.subscribe(
  REDIS_CHANNELS.USER_BANNED,
  REDIS_CHANNELS.SESSION_REVOKED,
  REDIS_CHANNELS.USER_MUTED,
  REDIS_CHANNELS.BOT_MESSAGE_NEW,
  REDIS_CHANNELS.BOT_MESSAGE_EDIT,
  REDIS_CHANNELS.BOT_MESSAGE_DELETE,
  REDIS_CHANNELS.BOT_NEW_MEMBER,
  REDIS_CHANNELS.NOTIFICATION_BROADCAST,
  REDIS_CHANNELS.SYMBOLS_UPDATE,
  REDIS_CHANNELS.DM_MESSAGE_NEW,
  REDIS_CHANNELS.DM_CONVERSATION_UPDATED,
  REDIS_CHANNELS.TOPIC_MEMBERS_UPDATED,
  REDIS_CHANNELS.MOD_FLAG_COUNT,
  (err) => { if (err) log.error("redis subscribe failed", err); },
);

subClient.on("message", (channel, message) => {
  try {
    if (channel === REDIS_CHANNELS.USER_BANNED) {
      const { userId } = JSON.parse(message) as { userId: string };
      io.to(`user:${userId}`).disconnectSockets(true);
    } else if (channel === REDIS_CHANNELS.SESSION_REVOKED) {
      // Logout (#rt-1). Same treatment as a ban: a socket authenticated once at
      // handshake would otherwise stay fully authorized until its access token
      // expired. Dropping every socket of the user is safe — other devices hold
      // their own valid cookies and Socket.IO reconnects them transparently,
      // while the tab that logged out has no cookie left to reconnect with.
      const { userId } = JSON.parse(message) as { userId: string; jti?: string };
      io.to(`user:${userId}`).disconnectSockets(true);
    } else if (channel === REDIS_CHANNELS.USER_MUTED) {
      const { userId } = JSON.parse(message) as { userId: string };
      io.to(`user:${userId}`).emit(WS_EVENTS.USER_MUTED, { userId });
    } else if (channel === REDIS_CHANNELS.BOT_MESSAGE_NEW) {
      const { topicId, message: msg } = JSON.parse(message) as { topicId: string; message: { text?: string; senderDisplayName?: string | null; createdAt?: string } };
      io.to(`topic:${topicId}`).emit(WS_EVENTS.MESSAGE_NEW, msg);
      getTopicMemberUserIds(topicId)
        .then((ids) => filterUsersWhoCanViewTopic(topicId, ids)) // #rt-5
        .then((memberIds) => {
          const sidebarPayload = {
            topicId,
            preview: stripMarkdownPreview(msg.text ?? ""),
            senderId: null as string | null,
            senderName: msg.senderDisplayName ?? null,
            at: msg.createdAt ?? new Date().toISOString(),
          };
          for (const memberId of memberIds) {
            io.to(`user:${memberId}`).emit(WS_EVENTS.SIDEBAR_UPDATE, sidebarPayload);
          }
        })
        .catch((e) => log.error("sidebar bot broadcast failed", e));
    } else if (channel === REDIS_CHANNELS.BOT_MESSAGE_EDIT) {
      const { topicId, message: msg } = JSON.parse(message) as { topicId: string; message: unknown };
      io.to(`topic:${topicId}`).emit(WS_EVENTS.MESSAGE_EDIT, msg);
    } else if (channel === REDIS_CHANNELS.BOT_MESSAGE_DELETE) {
      const { topicId, id } = JSON.parse(message) as { topicId: string; id: string };
      io.to(`topic:${topicId}`).emit(WS_EVENTS.MESSAGE_DELETE, { id, topicId });
    } else if (channel === REDIS_CHANNELS.BOT_NEW_MEMBER) {
      const { userId, displayName, username, topicId } = JSON.parse(message) as {
        userId: string; displayName: string; username: string | null; topicId: string;
      };
      deliverNewMemberToWebhooks(userId, displayName, username, topicId)
        .catch((e) => log.error("webhook new_member delivery failed", e));
    } else if (channel === REDIS_CHANNELS.NOTIFICATION_BROADCAST) {
      const { notifs } = JSON.parse(message) as {
        notifs: Array<{ id: string; userId: string; type: string; payload: unknown; createdAt: string }>;
      };
      for (const n of notifs) {
        io.to(`user:${n.userId}`).emit(WS_EVENTS.NOTIFICATION_NEW, {
          id: n.id,
          type: n.type,
          payload: n.payload,
          readAt: null,
          createdAt: n.createdAt,
        });
      }
    } else if (channel === REDIS_CHANNELS.DM_MESSAGE_NEW) {
      const { message: msg, userIds } = JSON.parse(message) as {
        conversationId: string;
        isE2ee?: boolean;
        message: { id: string; conversationId: string; senderId: string; text: string; createdAt: string; senderType: string };
        userIds: string[];
      };
      for (const uid of userIds) {
        io.to(`user:${uid}`).emit(WS_EVENTS.DM_NEW, msg);
      }
      // TODO Plan B: when DM web-push is added, use a generic preview when isE2ee:
      //   const previewText = isE2ee ? "New message" : truncate(msg.text, 80);
      // Mirror the notifyTopicMembers() call above but for DM participants.
      // Analogue of notifyTopicMembers() (topic push, ~line 272 above) but for DMs.
    } else if (channel === REDIS_CHANNELS.DM_CONVERSATION_UPDATED) {
      // accept/decline → fan a lightweight signal to each participant so their
      // ChatListPane can refresh the server snapshot (incoming/state flip).
      const { conversationId, state, userIds } = JSON.parse(message) as {
        conversationId: string;
        // `"declined"` is a synthetic state — there is no DB row for it (the
        // decline handler deletes the conversation). It's a signal to clients
        // that the row should be dropped from sidebars.
        state: "pending" | "accepted" | "blocked" | "declined";
        userIds: string[];
      };
      for (const uid of userIds) {
        io.to(`user:${uid}`).emit(WS_EVENTS.DM_CONVERSATION_UPDATED, {
          conversationId,
          state,
        });
      }
    } else if (channel === REDIS_CHANNELS.TOPIC_MEMBERS_UPDATED) {
      // E2EE topic key-rotation signal — published from
      // apps/ws/src/messages.ts:ensureTopicMembership on first join. Fan to
      // every connected viewer of the topic so TopicView can discard the
      // current Megolm session and reshare with the new full member set.
      const { topicId, action, affectedUserId, memberUserIds, adminUserIds } = JSON.parse(message) as {
        topicId: string;
        action: "join" | "leave";
        affectedUserId: string;
        memberUserIds: string[];
        adminUserIds: string[];
      };
      io.to(`topic:${topicId}`).emit(WS_EVENTS.TOPIC_MEMBERS_UPDATED, {
        topicId,
        action,
        affectedUserId,
        memberUserIds,
        adminUserIds,
      });
    } else if (channel === REDIS_CHANNELS.SYMBOLS_UPDATE) {
      io.emit(WS_EVENTS.SYMBOLS_UPDATE, {});
    } else if (channel === REDIS_CHANNELS.MOD_FLAG_COUNT) {
      const { count } = JSON.parse(message) as { count: number };
      // mod:queue room contains every connected user whose JWT has
      // MODERATION_QUEUE_REVIEW — join logic lives in the connection handler.
      io.to(MOD_ROOM).emit(WS_EVENTS.MOD_FLAG_COUNT, { count });
    }
  } catch (e) {
    log.error("pubsub parse failed", e);
  }
});

const cancelAutoDelete = startAutoDelete(io);

// Purge expired anon identities once per hour.
async function purgeExpiredAnonUsers() {
  try {
    const deleted = await db
      .delete(users)
      .where(and(eq(users.isAnon, true), lt(users.anonExpiresAt, new Date())))
      .returning({ id: users.id });
    if (deleted.length > 0) {
      log.info("anon-cleanup purged expired anon users", { count: deleted.length });
    }
  } catch (err) {
    log.error("anon-cleanup failed", err);
  }
}

const ANON_PURGE_INTERVAL_MS = 60 * 60 * 1000;
const cancelAnonPurge = runAsLeader({
  key: "legends:leader:anon-cleanup",
  intervalMs: ANON_PURGE_INTERVAL_MS,
  lockTtlMs: ANON_PURGE_INTERVAL_MS * 3,
  label: "anon-cleanup",
  tick: purgeExpiredAnonUsers,
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    cancelAutoDelete();
    cancelAnonPurge();
    clearInterval(reauthTimer);
  });
}

const port = Number(process.env.WS_PORT ?? 3001);
httpServer.listen(port, () => {
  log.info("listening", { port });
});
