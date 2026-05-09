import { createServer } from "node:http";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { Server, type Socket, type DefaultEventsMap } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { users, topicPrincipalGrants } from "@legends/db/schema";
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
  messageDeleteSchema,
  messageEditSchema,
  pollCloseSchema,
  pollVoteSchema,
  reactionToggleSchema,
  sendMessageSchema,
  topicReadSchema,
  stripMarkdownPreview,
  canPrincipal,
  type AccessTokenPayload,
  type TopicGrant,
  type GrantEffect,
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
  editMessage,
  ensureTopicMembership,
  getMessageOwner,
  getMessageTopicId,
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
} from "./messages";
import { deliverCallbackQueryToWebhooks, deliverMessageToWebhooks, deliverNewMemberToWebhooks } from "./webhook";
import { dispatchMessageNotifications } from "./notifications";
import { registerP2PHandlers } from "./p2p-signaling";
import { randomUUID } from "node:crypto";

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
  registerP2PHandlers(io, socket);

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
      const incomingHashtags = parsed.hashtags ?? [];
      const validHashtags = incomingHashtags
        .filter((t) => /^[#$][a-zA-Z]\w*$/.test(t))
        .slice(0, 20);
      const msg = await insertMessage({
        topicId: parsed.topicId,
        senderUserId: user.sub,
        text: parsed.content.text,
        attachments: parsed.content.attachments as import("./messages").MessageAttachment[] | undefined,
        replyToMessageId: parsed.content.replyToMessageId ?? null,
        searchText: isE2ee ? undefined : parsed.content.text,
        hashtags: validHashtags,
      });
      io.to(`topic:${parsed.topicId}`).emit(WS_EVENTS.MESSAGE_NEW, msg);
      ack?.({ ok: true, message: msg });
      const plainPreview = isE2ee ? "(encrypted message)" : stripMarkdownPreview(parsed.content.text, topic?.isFeed ?? false);
      // Broadcast sidebar update to all topic members so their sidebar refreshes in real time
      getTopicMemberUserIds(parsed.topicId).then((memberIds) => {
        const sidebarPayload = {
          topicId: parsed.topicId,
          preview: plainPreview,
          senderName: msg.senderDisplayName ?? null,
          at: typeof msg.createdAt === "string" ? msg.createdAt : (msg.createdAt as Date).toISOString(),
        };
        for (const memberId of memberIds) {
          io.to(`user:${memberId}`).emit(WS_EVENTS.SIDEBAR_UPDATE, sidebarPayload);
        }
      }).catch((e) => console.error("[sidebar] broadcast failed", e));
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
      }).catch((e) => console.error("[notifications] dispatch failed", e));
      if (!isE2ee) {
        deliverMessageToWebhooks(parsed.topicId, topic?.title ?? "", msg).catch((e) =>
          console.error("[webhook] delivery failed", e),
        );
      }
      notifyTopicMembers({
        topicId: parsed.topicId,
        senderUserId: user.sub,
        preview: plainPreview,
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

  socket.on(WS_EVENTS.MESSAGE_EDIT_REQ, async (raw: unknown, ack?: (res: unknown) => void) => {
    try {
      const parsed = messageEditSchema.parse(raw);
      const owner = await getMessageOwner(parsed.messageId);
      if (!owner || owner.topicId !== parsed.topicId) {
        ack?.({ ok: false, error: "not found" }); return;
      }
      const isOwn = owner.senderUserId === user.sub;
      const canEditAny = user.role !== "user";
      if (!isOwn && !canEditAny) {
        ack?.({ ok: false, error: "forbidden" }); return;
      }
      const updated = await editMessage({
        messageId: parsed.messageId,
        topicId: parsed.topicId,
        newText: parsed.text,
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
      const parsed = messageDeleteSchema.parse(raw);
      const owner = await getMessageOwner(parsed.messageId);
      if (!owner || owner.topicId !== parsed.topicId) {
        ack?.({ ok: false, error: "not found" }); return;
      }
      const isOwn = owner.senderUserId === user.sub;
      const canDeleteAny = user.role !== "user";
      if (!isOwn && !canDeleteAny) {
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
      const { botId, messageId, callbackData } = raw as { botId: string; messageId: string; callbackData: string };
      if (!botId || !messageId || !callbackData) { ack?.({ ok: false, error: "invalid payload" }); return; }
      const topicId = await getMessageTopicId(messageId);
      if (!topicId) { ack?.({ ok: false, error: "message not found" }); return; }
      const callbackQueryId = randomUUID();
      ack?.({ ok: true, callbackQueryId });
      deliverCallbackQueryToWebhooks(topicId, botId, callbackQueryId, messageId, user.sub, null, callbackData)
        .catch((e) => console.error("[webhook] callback delivery failed", e));
    } catch (err) {
      ack?.({ ok: false, error: (err as Error).message });
    }
  });
});

// React to ban/mute pubsub from the web app: force-disconnect affected users.
subClient.subscribe(
  REDIS_CHANNELS.USER_BANNED,
  REDIS_CHANNELS.USER_MUTED,
  REDIS_CHANNELS.BOT_MESSAGE_NEW,
  REDIS_CHANNELS.BOT_MESSAGE_EDIT,
  REDIS_CHANNELS.BOT_MESSAGE_DELETE,
  REDIS_CHANNELS.BOT_NEW_MEMBER,
  REDIS_CHANNELS.NOTIFICATION_BROADCAST,
  REDIS_CHANNELS.SYMBOLS_UPDATE,
  (err) => { if (err) console.error("redis subscribe failed", err); },
);

subClient.on("message", (channel, message) => {
  try {
    if (channel === REDIS_CHANNELS.USER_BANNED) {
      const { userId } = JSON.parse(message) as { userId: string };
      io.to(`user:${userId}`).disconnectSockets(true);
    } else if (channel === REDIS_CHANNELS.USER_MUTED) {
      const { userId } = JSON.parse(message) as { userId: string };
      io.to(`user:${userId}`).emit(WS_EVENTS.USER_MUTED, { userId });
    } else if (channel === REDIS_CHANNELS.BOT_MESSAGE_NEW) {
      const { topicId, message: msg } = JSON.parse(message) as { topicId: string; message: { text?: string; senderDisplayName?: string | null; createdAt?: string } };
      io.to(`topic:${topicId}`).emit(WS_EVENTS.MESSAGE_NEW, msg);
      getTopicMemberUserIds(topicId).then((memberIds) => {
        const sidebarPayload = {
          topicId,
          preview: stripMarkdownPreview(msg.text ?? ""),
          senderName: msg.senderDisplayName ?? null,
          at: msg.createdAt ?? new Date().toISOString(),
        };
        for (const memberId of memberIds) {
          io.to(`user:${memberId}`).emit(WS_EVENTS.SIDEBAR_UPDATE, sidebarPayload);
        }
      }).catch((e) => console.error("[sidebar] bot broadcast failed", e));
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
        .catch((e) => console.error("[webhook] new_member delivery failed", e));
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
    } else if (channel === REDIS_CHANNELS.SYMBOLS_UPDATE) {
      io.emit(WS_EVENTS.SYMBOLS_UPDATE, {});
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
