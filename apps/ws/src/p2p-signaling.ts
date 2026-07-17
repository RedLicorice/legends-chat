import type { Server, Socket, DefaultEventsMap } from "socket.io";
import { eq } from "drizzle-orm";
import { topics } from "@legends/db/schema";
import { getAllSettings } from "@legends/db/system-settings";
import { WS_EVENTS, canViewTopic, createLogger } from "@legends/shared";
import type { AccessTokenPayload } from "@legends/shared";
import { db } from "./db";
import { cacheClient } from "./redis";

const log = createLogger("p2p");

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface SocketData { user: AccessTokenPayload; }
type AuthedSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

const DEFAULT_STUN: IceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
const QUEUE_TTL = 300;

async function getIceServers(): Promise<IceServer[]> {
  const s = await getAllSettings(db);
  let stun: IceServer[];
  try { stun = s.stun_servers ? (JSON.parse(s.stun_servers) as IceServer[]) : DEFAULT_STUN; }
  catch { stun = DEFAULT_STUN; }
  const servers: IceServer[] = [...stun];
  if (s.turn_url) servers.push({ urls: s.turn_url, username: s.turn_username ?? undefined, credential: s.turn_credential ?? undefined });
  return servers;
}

async function getTopicP2pConfig(topicId: string): Promise<{ isE2ee: boolean; p2pFallbackE2ee: boolean; p2pMaxParticipants: number | null } | null> {
  const [t] = await db.select({ isE2ee: topics.isE2ee, p2pFallbackE2ee: topics.p2pFallbackE2ee, p2pMaxParticipants: topics.p2pMaxParticipants }).from(topics).where(eq(topics.id, topicId)).limit(1);
  return t ?? null;
}

// Same view gate as the REST routes / TOPIC_JOIN. Without it, any authed socket
// could P2P_JOIN a private topic — harvesting TURN credentials and joining the
// call. Returns false for missing topics too (fail closed).
async function topicViewable(userRole: string, topicId: string): Promise<boolean> {
  const [t] = await db
    .select({ viewRoles: topics.viewRoles, readRoles: topics.readRoles })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1);
  if (!t) return false;
  return canViewTopic(userRole, t.viewRoles as string[] | null, t.readRoles as string[] | null);
}

async function getActiveCount(topicId: string): Promise<number> {
  return cacheClient.hlen(`p2p:active:${topicId}`);
}

async function getActivePeers(topicId: string): Promise<string[]> {
  const h = await cacheClient.hgetall(`p2p:active:${topicId}`);
  return Object.keys(h ?? {});
}

async function addActive(topicId: string, userId: string): Promise<void> {
  await cacheClient.hset(`p2p:active:${topicId}`, userId, Date.now().toString());
}

async function removeActive(topicId: string, userId: string): Promise<void> {
  await cacheClient.hdel(`p2p:active:${topicId}`, userId);
}

async function enqueue(topicId: string, userId: string): Promise<number> {
  const queue = await cacheClient.lrange(`p2p:queue:${topicId}`, 0, -1);
  if (!queue.includes(userId)) {
    await cacheClient.rpush(`p2p:queue:${topicId}`, userId);
    await cacheClient.set(`p2p:queue-ttl:${topicId}:${userId}`, "1", "EX", QUEUE_TTL);
  }
  const updated = await cacheClient.lrange(`p2p:queue:${topicId}`, 0, -1);
  return updated.indexOf(userId) + 1;
}

async function dequeueNext(topicId: string): Promise<string | null> {
  let uid = await cacheClient.lpop(`p2p:queue:${topicId}`);
  while (uid) {
    const alive = await cacheClient.exists(`p2p:queue-ttl:${topicId}:${uid}`);
    if (alive) {
      await cacheClient.del(`p2p:queue-ttl:${topicId}:${uid}`);
      return uid;
    }
    uid = await cacheClient.lpop(`p2p:queue:${topicId}`);
  }
  return null;
}

async function removeFromQueue(topicId: string, userId: string): Promise<void> {
  await cacheClient.lrem(`p2p:queue:${topicId}`, 0, userId);
  await cacheClient.del(`p2p:queue-ttl:${topicId}:${userId}`);
}

async function handleLeave(io: Server, topicId: string, userId: string): Promise<void> {
  await removeActive(topicId, userId);
  await removeFromQueue(topicId, userId);

  io.to(`topic:${topicId}`).emit(WS_EVENTS.P2P_PEER_LEFT, { userId });

  const nextUserId = await dequeueNext(topicId);
  if (nextUserId) {
    const iceServers = await getIceServers();
    io.to(`user:${nextUserId}`).emit(WS_EVENTS.P2P_ADMITTED, { topicId, iceServers });
  }

  const s = await getAllSettings(db);
  const globalMax = parseInt(s.p2p_max_participants ?? "5", 10);
  const topic = await getTopicP2pConfig(topicId);
  if (!topic) return;
  const maxPeers = topic.p2pMaxParticipants ?? globalMax;
  const activeCount = await getActiveCount(topicId);
  if (topic.isE2ee && topic.p2pFallbackE2ee && activeCount <= maxPeers) {
    io.to(`topic:${topicId}`).emit(WS_EVENTS.P2P_RESUME, { topicId });
  }
}

// Track which topics each socket has joined, for disconnect cleanup
const socketTopics = new Map<string, Set<string>>();

export function registerP2PHandlers(io: Server, socket: AuthedSocket): void {
  const userId = socket.data.user.sub;
  const userRole = socket.data.user.role;
  socketTopics.set(socket.id, new Set());

  socket.on(WS_EVENTS.P2P_JOIN, async ({ topicId }: { topicId: string }) => {
    try {
      // Authorization gate — reject before touching ICE/TURN creds or presence.
      if (!(await topicViewable(userRole, topicId))) return;
      socketTopics.get(socket.id)?.add(topicId);
      const s = await getAllSettings(db);
      const globalMax = parseInt(s.p2p_max_participants ?? "5", 10);
      const [topic, iceServers, activePeers] = await Promise.all([
        getTopicP2pConfig(topicId),
        getIceServers(),
        getActivePeers(topicId),
      ]);
      const maxPeers = (topic?.p2pMaxParticipants ?? globalMax);
      const otherPeers = activePeers.filter((id) => id !== userId);

      if (otherPeers.length >= maxPeers) {
        if (topic?.isE2ee && topic?.p2pFallbackE2ee) {
          await addActive(topicId, userId);
          io.to(`topic:${topicId}`).emit(WS_EVENTS.P2P_FALLBACK, { topicId });
          socket.emit(WS_EVENTS.P2P_JOINED, { iceServers, activePeers: otherPeers, fallback: true });
        } else {
          const position = await enqueue(topicId, userId);
          socket.emit(WS_EVENTS.P2P_QUEUED, { position });
        }
        return;
      }

      await addActive(topicId, userId);
      socket.emit(WS_EVENTS.P2P_JOINED, { iceServers, activePeers: otherPeers, fallback: false });
      // Tell existing peers — they'll each create an offer to the new joiner
      for (const peerId of otherPeers) {
        io.to(`user:${peerId}`).emit(WS_EVENTS.P2P_PEER_JOINED, { userId });
      }
    } catch (e) {
      log.error("join failed", e);
    }
  });

  // Relay only between two peers that are BOTH active in the topic. Active
  // membership implies each passed the P2P_JOIN view gate, so this blocks
  // signaling into topics the sender can't access and relaying to arbitrary
  // user ids (offer/ICE spam).
  async function relayAllowed(topicId: string, toUserId: string): Promise<boolean> {
    const peers = await getActivePeers(topicId);
    return peers.includes(userId) && peers.includes(toUserId);
  }

  socket.on(WS_EVENTS.P2P_OFFER, async ({ topicId, toUserId, offer }: { topicId: string; toUserId: string; offer: RTCSessionDescriptionInit }) => {
    if (!(await relayAllowed(topicId, toUserId))) return;
    io.to(`user:${toUserId}`).emit(WS_EVENTS.P2P_OFFER, { fromUserId: userId, offer });
  });

  socket.on(WS_EVENTS.P2P_ANSWER, async ({ topicId, toUserId, answer }: { topicId: string; toUserId: string; answer: RTCSessionDescriptionInit }) => {
    if (!(await relayAllowed(topicId, toUserId))) return;
    io.to(`user:${toUserId}`).emit(WS_EVENTS.P2P_ANSWER, { fromUserId: userId, answer });
  });

  socket.on(WS_EVENTS.P2P_ICE, async ({ topicId, toUserId, candidate }: { topicId: string; toUserId: string; candidate: RTCIceCandidateInit }) => {
    if (!(await relayAllowed(topicId, toUserId))) return;
    io.to(`user:${toUserId}`).emit(WS_EVENTS.P2P_ICE, { fromUserId: userId, candidate });
  });

  socket.on(WS_EVENTS.P2P_HEARTBEAT, async ({ topicId }: { topicId: string }) => {
    // Only refresh presence for a peer already admitted — a heartbeat must not
    // insert an un-joined (ungated) user into the active set.
    const isActive = await cacheClient.hexists(`p2p:active:${topicId}`, userId).catch(() => 0);
    if (!isActive) return;
    await cacheClient.hset(`p2p:active:${topicId}`, userId, Date.now().toString()).catch(() => {});
  });

  socket.on(WS_EVENTS.P2P_LEAVE, async ({ topicId }: { topicId: string }) => {
    socketTopics.get(socket.id)?.delete(topicId);
    await handleLeave(io, topicId, userId).catch((e) => log.error("leave failed", e));
  });

  socket.on("disconnect", async () => {
    const joined = socketTopics.get(socket.id);
    socketTopics.delete(socket.id);
    if (!joined) return;
    for (const topicId of joined) {
      await handleLeave(io, topicId, userId).catch(() => {});
    }
  });
}
