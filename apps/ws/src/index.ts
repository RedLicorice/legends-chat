import { createServer } from "node:http";
import { and, eq, lt } from "drizzle-orm";
import { Server, type Socket, type DefaultEventsMap } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { users } from "@legends/db/schema";
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
import {
  ACCESS_COOKIE,
  REDIS_CHANNELS,
  WS_EVENTS,
  createPollSchema,
  pollCloseSchema,
  pollVoteSchema,
  reactionToggleSchema,
  sendMessageSchema,
  topicReadSchema,
  type AccessTokenPayload,
} from "@legends/shared";
import { isJtiRevoked, parseCookie, verifyAccessToken } from "./auth";
import { pubClient, subClient } from "./redis";
import { purgeCountModeForTopic, startAutoDelete } from "./autodelete";
import { getTopicAutoDelete } from "./messages";
import { notifyTopicMembers } from "./push";
import {
  castPollVote,
  closePollById,
  createPollMessage,
  ensureTopicMembership,
  getMessageTopicId,
  getMyPollVotes,
  insertMessage,
  isUserMuted,
  listReactionsForTopic,
  listRecentMessages,
  setLastReadMessage,
  toggleReaction,
  getTopicById,
} from "./messages";

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
  "http://localhost:3000",
].filter(Boolean) as string[];

const io = new Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

io.adapter(createAdapter(pubClient, subClient));

io.use(async (socket, next) => {
  try {
    const token = parseCookie(socket.handshake.headers.cookie, ACCESS_COOKIE);
    if (!token) return next(new Error("no auth cookie"));
    const payload = await verifyAccessToken(token);
    if (await isJtiRevoked(payload.jti)) return next(new Error("token revoked"));
    socket.data.user = payload;
    next();
  } catch (err) {
    next(err instanceof Error ? err : new Error("auth failed"));
  }
});

io.on("connection", async (socket: AuthedSocket) => {
  const user = socket.data.user;
  socket.join(`user:${user.sub}`);

  // Track online presence (skip if user opted out)
  const optOut = await isPresenceOptOut(user.sub).catch(() => false);
  if (!optOut) {
    await markOnline(user.sub).catch(() => {});
    // Broadcast to all rooms this user is in
    socket.broadcast.emit(WS_EVENTS.PRESENCE_UPDATE, { userId: user.sub, online: true });
  }

  socket.on("disconnect", async () => {
    if (!optOut) {
      await markOffline(user.sub).catch(() => {});
      io.emit(WS_EVENTS.PRESENCE_UPDATE, { userId: user.sub, online: false });
    }
  });

  socket.on(WS_EVENTS.TOPIC_JOIN, async (topicId: string, ack?: (res: unknown) => void) => {
    try {
      await ensureTopicMembership(user.sub, topicId);
      socket.join(`topic:${topicId}`);
      const [recent, reactions, onlineIds] = await Promise.all([
        listRecentMessages(topicId, 50, user.sub),
        listReactionsForTopic(topicId, 50),
        optOut ? Promise.resolve([]) : getOnlineUsers(),
      ]);
      const pollIds = recent.filter((m) => m.poll).map((m) => m.poll!.id);
      const myPollVotes = await getMyPollVotes(user.sub, pollIds);
      ack?.({ ok: true, messages: recent, reactions, onlineUserIds: optOut ? [] : onlineIds, myPollVotes });
    } catch (err) {
      ack?.({ ok: false, error: (err as Error).message });
    }
  });

  socket.on(WS_EVENTS.TOPIC_LEAVE, (topicId: string) => {
    socket.leave(`topic:${topicId}`);
  });

  socket.on(WS_EVENTS.MESSAGE_SEND, async (raw: unknown, ack?: (res: unknown) => void) => {
    try {
      const parsed = sendMessageSchema.parse(raw);
      const muted = await isUserMuted(user.sub);
      if (muted) {
        ack?.({ ok: false, error: "MUTED", reason: muted.reason, expiresAt: muted.expiresAt });
        return;
      }
      const topic = await getTopicById(parsed.topicId);
      const isE2ee = topic?.isE2ee ?? false;
      const msg = await insertMessage({
        topicId: parsed.topicId,
        senderUserId: user.sub,
        text: parsed.content.text,
        attachments: parsed.content.attachments as import("./messages").MessageAttachment[] | undefined,
        replyToMessageId: parsed.content.replyToMessageId ?? null,
        searchText: isE2ee ? undefined : parsed.content.text,
      });
      io.to(`topic:${parsed.topicId}`).emit(WS_EVENTS.MESSAGE_NEW, msg);
      ack?.({ ok: true, message: msg });
      notifyTopicMembers({
        topicId: parsed.topicId,
        senderUserId: user.sub,
        preview: parsed.content.text,
        messageId: msg.id,
      }).catch((e) => console.error("[push] notify failed", e));
      const cfg = await getTopicAutoDelete(parsed.topicId);
      if (cfg?.mode === "count" && cfg.max) {
        purgeCountModeForTopic(io, parsed.topicId, cfg.max).catch((e) =>
          console.error("[autodelete] count purge failed", e),
        );
      }
    } catch (err) {
      ack?.({ ok: false, error: (err as Error).message });
    }
  });

  socket.on(WS_EVENTS.TOPIC_READ, async (raw: unknown) => {
    try {
      const parsed = topicReadSchema.parse(raw);
      await setLastReadMessage(user.sub, parsed.topicId, parsed.lastReadMessageId);
    } catch (err) {
      console.error("topic:read failed", err);
    }
  });

  socket.on(WS_EVENTS.POLL_CREATE, async (raw: unknown, ack?: (res: unknown) => void) => {
    try {
      if (user.role === "user") {
        ack?.({ ok: false, error: "Insufficient permissions" });
        return;
      }
      const parsed = createPollSchema.parse(raw);
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
      const parsed = pollVoteSchema.parse(raw);
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
      if (user.role === "user") { ack?.({ ok: false, error: "Insufficient permissions" }); return; }
      const parsed = pollCloseSchema.parse(raw);
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
});

// React to ban/mute pubsub from the web app: force-disconnect affected users.
subClient.subscribe(REDIS_CHANNELS.USER_BANNED, REDIS_CHANNELS.USER_MUTED, (err) => {
  if (err) console.error("redis subscribe failed", err);
});

subClient.on("message", (channel, message) => {
  try {
    const { userId } = JSON.parse(message) as { userId: string };
    if (channel === REDIS_CHANNELS.USER_BANNED) {
      io.to(`user:${userId}`).disconnectSockets(true);
    } else if (channel === REDIS_CHANNELS.USER_MUTED) {
      io.to(`user:${userId}`).emit(WS_EVENTS.USER_MUTED, { userId });
    }
  } catch (e) {
    console.error("pubsub parse failed", e);
  }
});

startAutoDelete(io);

// Purge expired anon identities once per hour.
async function purgeExpiredAnonUsers() {
  try {
    const deleted = await db
      .delete(users)
      .where(and(eq(users.isAnon, true), lt(users.anonExpiresAt, new Date())))
      .returning({ id: users.id });
    if (deleted.length > 0) {
      console.log(`[anon-cleanup] purged ${deleted.length} expired anon user(s)`);
    }
  } catch (err) {
    console.error("[anon-cleanup] failed", err);
  }
}
purgeExpiredAnonUsers();
setInterval(purgeExpiredAnonUsers, 60 * 60 * 1000);

const port = Number(process.env.WS_PORT ?? 3001);
httpServer.listen(port, () => {
  console.log(`legends-chat ws listening on :${port}`);
});
