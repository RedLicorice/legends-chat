"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Lock, Send } from "lucide-react";
import { io, type Socket } from "socket.io-client";
import { WS_EVENTS } from "@legends/shared";
import { cn } from "@/lib/cn";

interface Message {
  id: string;
  topicId: string;
  senderUserId: string | null;
  botId: string | null;
  replyToMessageId: string | null;
  text: string;
  createdAt: string | Date;
  editedAt: string | Date | null;
}

interface TopicViewProps {
  topic: { id: string; slug: string; title: string; isE2ee: boolean };
  currentUser: { id: string; displayName: string };
  mute: { reason: string; expiresAt: string | null } | null;
}

export function TopicView({ topic, currentUser, mute }: TopicViewProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const wsUrl = useMemo(
    () =>
      typeof window !== "undefined"
        ? (window as unknown as { __WS_URL?: string }).__WS_URL ??
          process.env.NEXT_PUBLIC_WS_URL ??
          "http://localhost:3001"
        : "http://localhost:3001",
    [],
  );

  useEffect(() => {
    const socket = io(wsUrl, { withCredentials: true, transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      socket.emit(
        WS_EVENTS.TOPIC_JOIN,
        topic.id,
        (res: { ok: boolean; messages?: Message[]; error?: string }) => {
          if (res.ok && res.messages) setMessages(res.messages);
        },
      );
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on(WS_EVENTS.MESSAGE_NEW, (msg: Message) => {
      if (msg.topicId !== topic.id) return;
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    });

    return () => {
      socket.emit(WS_EVENTS.TOPIC_LEAVE, topic.id);
      socket.disconnect();
    };
  }, [topic.id, wsUrl]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    const last = messages[messages.length - 1];
    if (last) socketRef.current?.emit(WS_EVENTS.TOPIC_READ, { topicId: topic.id, lastReadMessageId: last.id });
  }, [messages, topic.id]);

  function send() {
    const text = draft.trim();
    if (!text || mute) return;
    socketRef.current?.emit(
      WS_EVENTS.MESSAGE_SEND,
      { topicId: topic.id, content: { text } },
      (res: { ok: boolean; error?: string }) => {
        if (!res.ok) console.warn("send failed", res.error);
      },
    );
    setDraft("");
  }

  return (
    <>
      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        {topic.isE2ee && <Lock className="h-4 w-4 text-accent2" />}
        <div>
          <h1 className="text-lg font-semibold">{topic.title}</h1>
          <p className="text-xs text-muted">{connected ? "connected" : "connecting…"}</p>
        </div>
      </header>

      <div ref={scrollerRef} className="flex-1 space-y-2 overflow-y-auto px-6 py-4">
        <AnimatePresence initial={false}>
          {messages.map((m) => {
            const mine = m.senderUserId === currentUser.id;
            return (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className={cn("flex", mine ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[78%] rounded-2xl px-4 py-2 text-sm",
                    mine ? "bg-accent text-white" : "bg-panel2 text-text",
                  )}
                >
                  <div className="whitespace-pre-wrap break-words">{m.text}</div>
                  <div className={cn("mt-1 text-[10px]", mine ? "text-white/70" : "text-muted")}>
                    {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {mute ? (
        <div className="border-t border-border bg-panel px-6 py-4 text-sm text-danger">
          You are muted: {mute.reason}
          {mute.expiresAt ? ` (until ${new Date(mute.expiresAt).toLocaleString()})` : " (permanent)"}
        </div>
      ) : (
        <div className="border-t border-border bg-panel p-3">
          <div className="flex items-center gap-2 rounded-xl bg-panel2 px-3 py-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Write a message…"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            />
            <button
              type="button"
              onClick={send}
              className="rounded-lg bg-accent p-2 text-white transition hover:opacity-90 disabled:opacity-40"
              disabled={!draft.trim()}
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
