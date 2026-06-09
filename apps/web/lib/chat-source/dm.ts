"use client";
import { io, type Socket } from "socket.io-client";
import { WS_EVENTS } from "@legends/shared";
import { apiFetch } from "@/lib/fetch";
import type {
  ChatMessage,
  ChatSendPayload,
  ChatSource,
  ChatSourceCapabilities,
  ChatSourceHandlers,
} from "./index";

const DM_CAPS: ChatSourceCapabilities = {
  edit: false,
  delete: false,
  reactions: false,
  polls: false,
  hashtags: false,
  mentions: false,
  members: false,
  presence: false,
  threads: false,
};

interface DmIncoming {
  id: string;
  conversationId: string;
  senderType: string;
  senderId: string;
  text?: string | null;
  ciphertext?: Record<string, unknown> | null;
  replyToMessageId?: string | null;
  createdAt: string;
}

interface DmListResponse {
  messages: Array<{
    id: string;
    conversationId: string;
    senderType: string;
    senderId: string;
    text: string;
    ciphertext: Record<string, unknown> | null;
    replyToMessageId: string | null;
    createdAt: string;
    editedAt: string | null;
  }>;
  isE2ee: boolean;
  e2eeRoomId: string | null;
}

interface PeerLookup {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface DmChatSourceOptions {
  conversationId: string;
  currentUserId: string;
  peer: PeerLookup | null;
  roomKey: string | null;
}

function toChatMessage(row: DmListResponse["messages"][number], peer: PeerLookup | null, currentUserId: string): ChatMessage {
  const isSelf = row.senderId === currentUserId;
  return {
    id: row.id,
    topicId: row.conversationId,
    senderUserId: row.senderId,
    senderDisplayName: isSelf ? null : peer?.displayName ?? null,
    senderAvatarUrl: isSelf ? null : peer?.avatarUrl ?? null,
    senderIsAnon: false,
    senderRole: null,
    botId: row.senderType === "bot" ? row.senderId : null,
    replyToMessageId: row.replyToMessageId,
    text: row.text ?? "",
    attachments: [],
    inlineKeyboard: null,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    ciphertextJson: row.ciphertext,
  };
}

export function createDmChatSource({ conversationId, currentUserId, peer, roomKey }: DmChatSourceOptions): ChatSource {
  const wsUrl = typeof window !== "undefined" ? window.location.origin : "";
  let socket: Socket | null = null;

  return {
    kind: "dm",
    capabilities: DM_CAPS,
    roomKey,
    get socket() {
      return socket;
    },
    subscribe(handlers: ChatSourceHandlers): () => void {
      const s = io(wsUrl, { withCredentials: true, transports: ["polling", "websocket"] });
      socket = s;

      s.on("connect", async () => {
        try {
          const res = await apiFetch(`/api/dm/${conversationId}/messages`);
          if (!res.ok) {
            handlers.onConnect?.({ messages: [] });
            return;
          }
          const data = (await res.json()) as DmListResponse;
          handlers.onConnect?.({
            messages: data.messages.map((r) => toChatMessage(r, peer, currentUserId)),
          });
        } catch {
          handlers.onConnect?.({ messages: [] });
        }
      });
      s.on("disconnect", () => { handlers.onDisconnect?.(); });

      s.on(WS_EVENTS.DM_NEW, (m: DmIncoming) => {
        if (m.conversationId !== conversationId) return;
        handlers.onNew(toChatMessage({
          id: m.id,
          conversationId: m.conversationId,
          senderType: m.senderType,
          senderId: m.senderId,
          text: m.text ?? "",
          ciphertext: m.ciphertext ?? null,
          replyToMessageId: m.replyToMessageId ?? null,
          createdAt: m.createdAt,
          editedAt: null,
        }, peer, currentUserId));
      });
      s.on(WS_EVENTS.DM_EDIT, (m: DmIncoming) => {
        if (m.conversationId !== conversationId) return;
        handlers.onEdit(toChatMessage({
          id: m.id,
          conversationId: m.conversationId,
          senderType: m.senderType,
          senderId: m.senderId,
          text: m.text ?? "",
          ciphertext: m.ciphertext ?? null,
          replyToMessageId: m.replyToMessageId ?? null,
          createdAt: m.createdAt,
          editedAt: null,
        }, peer, currentUserId));
      });
      s.on(WS_EVENTS.DM_DELETE, (d: { id: string; conversationId: string }) => {
        if (d.conversationId !== conversationId) return;
        handlers.onDelete(d.id);
      });

      let refreshing = false;
      s.on("connect_error", async (err: Error) => {
        const msg = err?.message ?? "";
        if (msg === "no auth cookie" || msg === "auth failed" || msg === "token revoked") {
          if (refreshing) return;
          refreshing = true;
          const ok = await fetch("/api/auth/refresh", { method: "POST" }).then((r) => r.ok).catch(() => false);
          refreshing = false;
          if (!ok && typeof window !== "undefined") {
            window.location.replace("/login");
          }
        }
      });

      return () => {
        s.removeAllListeners();
        s.disconnect();
        if (socket === s) socket = null;
      };
    },
    async send(payload: ChatSendPayload): Promise<void> {
      const body: Record<string, unknown> = {};
      if (payload.ciphertextJson) {
        body.ciphertext = payload.ciphertextJson;
      } else {
        body.text = payload.text;
      }
      if (payload.replyToMessageId) body.replyToMessageId = payload.replyToMessageId;
      const res = await apiFetch(`/api/dm/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return;
    },
  };
}
