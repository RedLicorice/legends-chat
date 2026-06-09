"use client";
import { io, type Socket } from "socket.io-client";
import { WS_EVENTS } from "@legends/shared";
import type {
  ChatMessage,
  ChatReactionRow,
  ChatSendPayload,
  ChatSource,
  ChatSourceCapabilities,
  ChatSourceHandlers,
} from "./index";

const TOPIC_CAPS: ChatSourceCapabilities = {
  edit: true,
  delete: true,
  reactions: true,
  polls: true,
  hashtags: true,
  mentions: true,
  members: true,
  presence: true,
  threads: true,
};

export interface TopicChatSourceOptions {
  topicId: string;
  isE2ee: boolean;
  isFeed: boolean;
}

export function createTopicChatSource({ topicId, isE2ee }: TopicChatSourceOptions): ChatSource {
  const wsUrl = typeof window !== "undefined" ? window.location.origin : "";
  let socket: Socket | null = null;

  return {
    kind: "topic",
    capabilities: TOPIC_CAPS,
    roomKey: isE2ee ? `!${topicId}:legends.local` : null,
    get socket() {
      return socket;
    },
    subscribe(handlers: ChatSourceHandlers): () => void {
      const s = io(wsUrl, { withCredentials: true, transports: ["polling", "websocket"] });
      socket = s;

      s.on("connect", () => {
        s.emit(
          WS_EVENTS.TOPIC_JOIN,
          topicId,
          (res: {
            ok: boolean;
            messages?: ChatMessage[];
            reactions?: ChatReactionRow[];
            onlineUserIds?: string[];
            myPollVotes?: Record<string, string[]>;
            error?: string;
          }) => {
            if (!res.ok) return;
            handlers.onConnect?.({
              messages: res.messages,
              reactions: res.reactions,
              onlineUserIds: res.onlineUserIds,
              myPollVotes: res.myPollVotes,
            });
          },
        );
      });
      s.on("disconnect", () => { handlers.onDisconnect?.(); });

      s.on(WS_EVENTS.MESSAGE_NEW, (m: ChatMessage) => {
        if (m.topicId !== topicId) return;
        handlers.onNew(m);
      });
      s.on(WS_EVENTS.MESSAGE_EDIT, (m: ChatMessage) => {
        if (m.topicId !== topicId) return;
        handlers.onEdit(m);
      });
      s.on(WS_EVENTS.MESSAGE_DELETE, (d: { id: string; topicId: string }) => {
        if (d.topicId !== topicId) return;
        handlers.onDelete(d.id);
      });
      s.on(WS_EVENTS.REACTION_ADD, (r: ChatReactionRow) => { handlers.onReactionAdd(r); });
      s.on(WS_EVENTS.REACTION_REMOVE, (r: ChatReactionRow) => { handlers.onReactionRemove(r); });

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
        s.emit(WS_EVENTS.TOPIC_LEAVE, topicId);
        s.removeAllListeners();
        s.disconnect();
        if (socket === s) socket = null;
      };
    },
    async send(payload: ChatSendPayload): Promise<void> {
      const s = socket;
      if (!s) return;
      await new Promise<void>((resolve) => {
        s.emit(
          WS_EVENTS.MESSAGE_SEND,
          {
            topicId,
            content: {
              text: payload.text,
              attachments: payload.attachments && payload.attachments.length > 0 ? payload.attachments : undefined,
              replyToMessageId: payload.replyToMessageId ?? undefined,
              hashtags: payload.hashtags && payload.hashtags.length > 0 ? payload.hashtags.slice(0, 20) : undefined,
              ciphertextJson: payload.ciphertextJson,
            },
          },
          (res: { ok: boolean; error?: string }) => {
            if (!res.ok) console.warn("send failed", res.error);
            resolve();
          },
        );
      });
    },
    async edit(messageId: string, payload: { text?: string; ciphertextJson?: Record<string, unknown> }): Promise<void> {
      const s = socket;
      if (!s) return;
      await new Promise<void>((resolve) => {
        s.emit(
          WS_EVENTS.MESSAGE_EDIT_REQ,
          { messageId, topicId, ...payload },
          (res: { ok: boolean; error?: string }) => {
            if (!res.ok) console.warn("edit failed", res.error);
            resolve();
          },
        );
      });
    },
    async remove(messageId: string): Promise<void> {
      socket?.emit(WS_EVENTS.MESSAGE_DELETE_REQ, { messageId, topicId });
    },
    async react(messageId: string, emojiKey: string): Promise<void> {
      socket?.emit(WS_EVENTS.REACTION_TOGGLE, { messageId, emojiKey });
    },
    markRead(lastReadMessageId: string): void {
      socket?.emit(WS_EVENTS.TOPIC_READ, { topicId, lastReadMessageId });
    },
  };
}
