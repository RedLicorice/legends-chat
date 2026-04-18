"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Flag, Lock, Send, SmilePlus } from "lucide-react";
import { io, type Socket } from "socket.io-client";
import { WS_EVENTS } from "@legends/shared";
import { cn } from "@/lib/cn";

interface Message {
  id: string;
  topicId: string;
  senderUserId: string | null;
  senderDisplayName: string | null;
  senderIsAnon: boolean;
  botId: string | null;
  replyToMessageId: string | null;
  text: string;
  createdAt: string | Date;
  editedAt: string | Date | null;
}

interface ReactionRow {
  messageId: string;
  userId: string;
  emojiKey: string;
}

const QUICK_EMOJI = ["thumbs_up", "heart", "joy", "fire", "tada"];
const EMOJI_GLYPH: Record<string, string> = {
  thumbs_up: "👍",
  heart: "❤️",
  joy: "😂",
  fire: "🔥",
  tada: "🎉",
};

interface TopicViewProps {
  topic: { id: string; slug: string; title: string; isE2ee: boolean };
  currentUser: { id: string; displayName: string; role: string };
  mute: { reason: string; expiresAt: string | null } | null;
}

export function TopicView({ topic, currentUser, mute }: TopicViewProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [reactions, setReactions] = useState<ReactionRow[]>([]);
  const [draft, setDraft] = useState("");
  const [connected, setConnected] = useState(false);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Connect to the same origin as the web app. Next.js proxies /socket.io/*
  // to the WS server via rewrites, so the auth cookie is always sent
  // same-origin regardless of environment (dev, ngrok, production).
  const wsUrl = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    let active = true;
    const socket = io(wsUrl, { withCredentials: true, transports: ["polling", "websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      if (!active) return;
      setConnected(true);
      socket.emit(
        WS_EVENTS.TOPIC_JOIN,
        topic.id,
        (res: { ok: boolean; messages?: Message[]; reactions?: ReactionRow[]; error?: string }) => {
          if (!active) return;
          if (res.ok) {
            if (res.messages) setMessages(res.messages);
            if (res.reactions) setReactions(res.reactions);
          }
        },
      );
    });
    socket.on("disconnect", () => { if (active) setConnected(false); });
    socket.on(WS_EVENTS.MESSAGE_NEW, (msg: Message) => {
      if (!active || msg.topicId !== topic.id) return;
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    });
    socket.on(WS_EVENTS.REACTION_ADD, (r: ReactionRow) => {
      if (!active) return;
      setReactions((prev) =>
        prev.some((x) => x.messageId === r.messageId && x.userId === r.userId && x.emojiKey === r.emojiKey)
          ? prev
          : [...prev, r],
      );
    });
    socket.on(WS_EVENTS.REACTION_REMOVE, (r: ReactionRow) => {
      if (!active) return;
      setReactions((prev) =>
        prev.filter((x) => !(x.messageId === r.messageId && x.userId === r.userId && x.emojiKey === r.emojiKey)),
      );
    });
    socket.on(WS_EVENTS.MESSAGE_DELETE, (d: { id: string; topicId: string }) => {
      if (!active || d.topicId !== topic.id) return;
      setMessages((prev) => prev.filter((m) => m.id !== d.id));
      setReactions((prev) => prev.filter((r) => r.messageId !== d.id));
    });

    return () => {
      active = false;
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

  const toggleReaction = useCallback(
    (messageId: string, emojiKey: string) => {
      socketRef.current?.emit(WS_EVENTS.REACTION_TOGGLE, { messageId, emojiKey });
      setPickerFor(null);
    },
    [],
  );

  const reportMessage = useCallback(async (messageId: string) => {
    const reason = window.prompt("Why are you reporting this message?")?.trim();
    if (!reason || reason.length < 3) return;
    const res = await fetch("/api/messages/flag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId, reason }),
    });
    if (res.ok) {
      window.alert("Reported. A moderator will review.");
    } else {
      window.alert("Failed to report.");
    }
  }, []);

  const reactionsByMessage = useMemo(() => {
    const map = new Map<string, Map<string, string[]>>();
    for (const r of reactions) {
      let perEmoji = map.get(r.messageId);
      if (!perEmoji) {
        perEmoji = new Map();
        map.set(r.messageId, perEmoji);
      }
      const users = perEmoji.get(r.emojiKey) ?? [];
      users.push(r.userId);
      perEmoji.set(r.emojiKey, users);
    }
    return map;
  }, [reactions]);

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
            const perEmoji = reactionsByMessage.get(m.id);
            return (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className={cn("group flex", mine ? "justify-end" : "justify-start")}
              >
                <div className={cn("max-w-[78%]", mine ? "items-end" : "items-start")}>
                  {!mine && m.senderDisplayName && (
                    <div className={cn(
                      "mb-0.5 text-xs font-medium",
                      m.senderIsAnon && currentUser.role === "admin"
                        ? "text-muted line-through"
                        : "text-accent2",
                    )}>
                      {m.senderDisplayName}
                      {m.senderIsAnon && currentUser.role === "admin" && (
                        <span className="ml-1 text-[10px] text-muted">(anon)</span>
                      )}
                    </div>
                  )}
                  <div
                    className={cn(
                      "rounded-2xl px-4 py-2 text-sm",
                      mine ? "bg-accent text-white" : "bg-panel2 text-text",
                      !mine && m.senderIsAnon && currentUser.role === "admin" && "opacity-70",
                    )}
                  >
                    <div className="whitespace-pre-wrap break-words">{m.text}</div>
                    <div suppressHydrationWarning className={cn("mt-1 text-[10px]", mine ? "text-white/70" : "text-muted")}>
                      {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>

                  {perEmoji && perEmoji.size > 0 && (
                    <div className={cn("mt-1 flex flex-wrap gap-1", mine ? "justify-end" : "justify-start")}>
                      {Array.from(perEmoji.entries()).map(([key, users]) => {
                        const reacted = users.includes(currentUser.id);
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => toggleReaction(m.id, key)}
                            className={cn(
                              "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                              reacted ? "border-accent bg-accent/20" : "border-border bg-panel",
                            )}
                          >
                            <span>{EMOJI_GLYPH[key] ?? key}</span>
                            <span className="text-muted">{users.length}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div
                    className={cn(
                      "mt-1 flex gap-2 opacity-0 transition group-hover:opacity-100",
                      mine ? "justify-end" : "justify-start",
                    )}
                  >
                    <button
                      type="button"
                      className="text-muted hover:text-text"
                      onClick={() => setPickerFor(pickerFor === m.id ? null : m.id)}
                      title="React"
                    >
                      <SmilePlus className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="text-muted hover:text-danger"
                      onClick={() => reportMessage(m.id)}
                      title="Report"
                    >
                      <Flag className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {pickerFor === m.id && (
                    <div
                      className={cn(
                        "mt-1 flex gap-1 rounded-xl border border-border bg-panel p-1",
                        mine ? "justify-end" : "justify-start",
                      )}
                    >
                      {QUICK_EMOJI.map((key) => (
                        <button
                          key={key}
                          type="button"
                          className="rounded-lg px-2 py-1 text-base hover:bg-panel2"
                          onClick={() => toggleReaction(m.id, key)}
                        >
                          {EMOJI_GLYPH[key]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {mute ? (
        <div suppressHydrationWarning className="border-t border-border bg-panel px-6 py-4 text-sm text-danger">
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
