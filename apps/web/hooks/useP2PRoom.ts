"use client";

import { useEffect, useRef, useCallback } from "react";
import type { Socket } from "socket.io-client";
import { WS_EVENTS } from "@legends/shared";

export interface P2PMessage {
  id: string;
  text: string;
  senderId: string;
  senderName: string;
  at: string;
}

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface UseP2PRoomOptions {
  topicId: string;
  userId: string;
  displayName: string;
  socket: Socket | null;
  onMessage: (msg: P2PMessage) => void;
  onQueued: (position: number) => void;
  onAdmitted: () => void;
  onFallback: () => void;
  onResume: () => void;
  onPeerCount: (count: number) => void;
  onConnected: () => void;
}

export function useP2PRoom({
  topicId,
  userId,
  displayName,
  socket,
  onMessage,
  onQueued,
  onAdmitted,
  onFallback,
  onResume,
  onPeerCount,
  onConnected,
}: UseP2PRoomOptions) {
  const peerConns = useRef<Map<string, RTCPeerConnection>>(new Map());
  const dataChannels = useRef<Map<string, RTCDataChannel>>(new Map());
  const iceServersRef = useRef<IceServer[]>([]);
  const pendingCandidates = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

  function createConn(peerId: string): RTCPeerConnection {
    const conn = new RTCPeerConnection({ iceServers: iceServersRef.current as RTCIceServer[] });
    peerConns.current.set(peerId, conn);

    conn.onicecandidate = (e) => {
      if (e.candidate && socket) {
        socket.emit(WS_EVENTS.P2P_ICE, { topicId, toUserId: peerId, candidate: e.candidate.toJSON() });
      }
    };

    conn.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(conn.connectionState)) {
        closePeer(peerId);
      }
    };

    conn.ondatachannel = (e) => {
      setupDataChannel(peerId, e.channel);
    };

    return conn;
  }

  function setupDataChannel(peerId: string, channel: RTCDataChannel) {
    dataChannels.current.set(peerId, channel);
    channel.onopen = () => {
      onPeerCount(dataChannels.current.size);
      onConnected();
    };
    channel.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as P2PMessage;
        onMessage(msg);
      } catch {}
    };
    channel.onclose = () => {
      dataChannels.current.delete(peerId);
      onPeerCount(dataChannels.current.size);
    };
  }

  function closePeer(peerId: string) {
    peerConns.current.get(peerId)?.close();
    peerConns.current.delete(peerId);
    dataChannels.current.delete(peerId);
    onPeerCount(peerConns.current.size);
  }

  async function flushCandidates(peerId: string, conn: RTCPeerConnection) {
    const candidates = pendingCandidates.current.get(peerId) ?? [];
    for (const c of candidates) {
      await conn.addIceCandidate(c).catch(() => {});
    }
    pendingCandidates.current.delete(peerId);
  }

  const sendMessage = useCallback((text: string): P2PMessage | null => {
    const openChannels = [...dataChannels.current.values()].filter((ch) => ch.readyState === "open");
    if (openChannels.length === 0) return null;
    const msg: P2PMessage = {
      id: crypto.randomUUID(),
      text,
      senderId: userId,
      senderName: displayName,
      at: new Date().toISOString(),
    };
    const data = JSON.stringify(msg);
    for (const ch of openChannels) ch.send(data);
    return msg;
  }, [userId, displayName]);

  useEffect(() => {
    if (!socket) return;

    socket.emit(WS_EVENTS.P2P_JOIN, { topicId });

    const heartbeatInterval = setInterval(() => {
      socket.emit(WS_EVENTS.P2P_HEARTBEAT, { topicId });
    }, 15_000);

    const onJoined = ({ iceServers }: { iceServers: IceServer[]; activePeers: string[]; fallback: boolean }) => {
      iceServersRef.current = iceServers;
    };

    // Existing peer creates offer to us (we are new joiner, they are told via p2p:peer-joined)
    const onOffer = async ({ fromUserId, offer }: { fromUserId: string; offer: RTCSessionDescriptionInit }) => {
      const conn = createConn(fromUserId);
      await conn.setRemoteDescription(offer);
      await flushCandidates(fromUserId, conn);
      const answer = await conn.createAnswer();
      await conn.setLocalDescription(answer);
      socket.emit(WS_EVENTS.P2P_ANSWER, { topicId, toUserId: fromUserId, answer });
    };

    // Our offer was answered
    const onAnswer = async ({ fromUserId, answer }: { fromUserId: string; answer: RTCSessionDescriptionInit }) => {
      const conn = peerConns.current.get(fromUserId);
      if (conn) {
        await conn.setRemoteDescription(answer).catch(() => {});
        await flushCandidates(fromUserId, conn);
      }
    };

    // New peer joined: we (existing peer) create offer to them
    const onPeerJoined = async ({ userId: peerId }: { userId: string }) => {
      const conn = createConn(peerId);
      const channel = conn.createDataChannel("chat");
      setupDataChannel(peerId, channel);
      const offer = await conn.createOffer();
      await conn.setLocalDescription(offer);
      socket.emit(WS_EVENTS.P2P_OFFER, { topicId, toUserId: peerId, offer });
    };

    const onIce = async ({ fromUserId, candidate }: { fromUserId: string; candidate: RTCIceCandidateInit }) => {
      const conn = peerConns.current.get(fromUserId);
      if (conn?.remoteDescription) {
        await conn.addIceCandidate(candidate).catch(() => {});
      } else {
        const pending = pendingCandidates.current.get(fromUserId) ?? [];
        pending.push(candidate);
        pendingCandidates.current.set(fromUserId, pending);
      }
    };

    const onPeerLeft = ({ userId: peerId }: { userId: string }) => closePeer(peerId);
    const onQueued_ = ({ position }: { position: number }) => onQueued(position);
    const onAdmitted_ = ({ iceServers }: { iceServers: IceServer[] }) => {
      iceServersRef.current = iceServers;
      socket.emit(WS_EVENTS.P2P_JOIN, { topicId });
      onAdmitted();
    };
    const onFallback_ = () => onFallback();
    const onResume_ = () => onResume();

    socket.on(WS_EVENTS.P2P_JOINED, onJoined);
    socket.on(WS_EVENTS.P2P_OFFER, onOffer);
    socket.on(WS_EVENTS.P2P_ANSWER, onAnswer);
    socket.on(WS_EVENTS.P2P_PEER_JOINED, onPeerJoined);
    socket.on(WS_EVENTS.P2P_ICE, onIce);
    socket.on(WS_EVENTS.P2P_PEER_LEFT, onPeerLeft);
    socket.on(WS_EVENTS.P2P_QUEUED, onQueued_);
    socket.on(WS_EVENTS.P2P_ADMITTED, onAdmitted_);
    socket.on(WS_EVENTS.P2P_FALLBACK, onFallback_);
    socket.on(WS_EVENTS.P2P_RESUME, onResume_);

    return () => {
      clearInterval(heartbeatInterval);
      socket.emit(WS_EVENTS.P2P_LEAVE, { topicId });
      socket.off(WS_EVENTS.P2P_JOINED, onJoined);
      socket.off(WS_EVENTS.P2P_OFFER, onOffer);
      socket.off(WS_EVENTS.P2P_ANSWER, onAnswer);
      socket.off(WS_EVENTS.P2P_PEER_JOINED, onPeerJoined);
      socket.off(WS_EVENTS.P2P_ICE, onIce);
      socket.off(WS_EVENTS.P2P_PEER_LEFT, onPeerLeft);
      socket.off(WS_EVENTS.P2P_QUEUED, onQueued_);
      socket.off(WS_EVENTS.P2P_ADMITTED, onAdmitted_);
      socket.off(WS_EVENTS.P2P_FALLBACK, onFallback_);
      socket.off(WS_EVENTS.P2P_RESUME, onResume_);
      for (const conn of peerConns.current.values()) conn.close();
      peerConns.current.clear();
      dataChannels.current.clear();
    };
  }, [socket, topicId]);

  return { sendMessage };
}
