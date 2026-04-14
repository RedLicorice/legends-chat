import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import {
  ACCESS_COOKIE,
  REDIS_CHANNELS,
  WS_EVENTS,
  reactionToggleSchema,
  sendMessageSchema,
  topicReadSchema,
  type AccessTokenPayload,
} from "@legends/shared";
import { isJtiRevoked, parseCookie, verifyAccessToken } from "./auth.js";
import { pubClient, subClient } from "./redis.js";
import { purgeCountModeForTopic, startAutoDelete } from "./autodelete.js";
import { getTopicAutoDelete } from "./messages.js";
import {
  ensureTopicMembership,
  getMessageTopicId,
  insertMessage,
  isUserMuted,
  listReactionsForTopic,
  listRecentMessages,
  setLastReadMessage,
  toggleReaction,
} from "./messages.js";

interface SocketData {
  user: AccessTokenPayload;
}
type AuthedSocket = Socket<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, SocketData>;

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("legends-chat ws ok\n");
});

const io = new Server<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, SocketData>(
  httpServer,
  {
    cors: {
      origin: process.env.WEB_URL ?? "http://localhost:3000",
      credentials: true,
    },
  },
);

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

io.on("connection", (socket: AuthedSocket) => {
  const user = socket.data.user;
  socket.join(`user:${user.sub}`);

  socket.on(WS_EVENTS.TOPIC_JOIN, async (topicId: string, ack?: (res: unknown) => void) => {
    try {
      await ensureTopicMembership(user.sub, topicId);
      socket.join(`topic:${topicId}`);
      const [recent, reactions] = await Promise.all([
        listRecentMessages(topicId, 50),
        listReactionsForTopic(topicId, 50),
      ]);
      ack?.({ ok: true, messages: recent, reactions });
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
      const msg = await insertMessage({
        topicId: parsed.topicId,
        senderUserId: user.sub,
        text: parsed.content.text,
        replyToMessageId: parsed.content.replyToMessageId ?? null,
      });
      io.to(`topic:${parsed.topicId}`).emit(WS_EVENTS.MESSAGE_NEW, msg);
      ack?.({ ok: true, message: msg });
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

const port = Number(process.env.WS_PORT ?? 3001);
httpServer.listen(port, () => {
  console.log(`legends-chat ws listening on :${port}`);
});
