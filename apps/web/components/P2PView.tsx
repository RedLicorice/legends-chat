"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Radio, Lock, ServerCrash, Users, Send, Menu, PanelLeftOpen } from "lucide-react";
import { useP2PRoom, type P2PMessage } from "@/hooks/useP2PRoom";
import { P2PQueueBanner } from "@/components/P2PQueueBanner";

interface Props {
  topic: { id: string; slug: string; title: string; isE2ee: boolean; p2pFallbackE2ee: boolean };
  currentUser: { id: string; displayName: string; avatarUrl: string | null; role: string };
  onMenuOpen?: () => void;
  showExpandSidebar?: boolean;
  onExpandSidebar?: () => void;
}

type P2PMode = "connecting" | "p2p" | "queued" | "fallback";

export function P2PView({ topic, currentUser, onMenuOpen, showExpandSidebar, onExpandSidebar }: Props) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [messages, setMessages] = useState<P2PMessage[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<P2PMode>("connecting");
  const [queuePosition, setQueuePosition] = useState(0);
  const [peerCount, setPeerCount] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const s = io(window.location.origin, { withCredentials: true, transports: ["polling", "websocket"] });
    setSocket(s);
    return () => { s.disconnect(); };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const onMessage = useCallback((msg: P2PMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const onQueued = useCallback((position: number) => {
    setQueuePosition(position);
    setMode("queued");
  }, []);

  const onAdmitted = useCallback(() => {
    setMode("connecting");
  }, []);

  const onFallback = useCallback(() => {
    setMode("fallback");
  }, []);

  const onResume = useCallback(() => {
    setMode("connecting");
  }, []);

  const onPeerCount = useCallback((count: number) => {
    setPeerCount(count);
  }, []);

  const onConnected = useCallback(() => {
    setMode("p2p");
  }, []);

  const { sendMessage } = useP2PRoom({
    topicId: topic.id,
    userId: currentUser.id,
    displayName: currentUser.displayName,
    socket,
    onMessage,
    onQueued,
    onAdmitted,
    onFallback,
    onResume,
    onPeerCount,
    onConnected,
  });

  function send() {
    const text = input.trim();
    if (!text) return;
    if (mode === "fallback") return; // fallback mode — can't use P2P send
    const msg = sendMessage(text);
    if (msg) {
      setMessages((prev) => [...prev, msg]);
      setInput("");
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  const canSend = mode === "p2p" && input.trim().length > 0;

  return (
    <div className="flex flex-1 min-w-0 flex-col overflow-x-hidden">
      {/* Header */}
      <div className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-panel px-4">
        {onMenuOpen && (
          <button type="button" onClick={onMenuOpen} className="rounded-md p-1.5 hover:bg-panel2 transition md:hidden">
            <Menu className="h-5 w-5" />
          </button>
        )}
        {showExpandSidebar && (
          <button type="button" onClick={onExpandSidebar} className="hidden md:flex shrink-0 rounded-md p-1.5 hover:bg-panel2 transition" title="Expand sidebar">
            <PanelLeftOpen className="h-5 w-5" />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <Radio className="h-4 w-4 shrink-0 text-accent" />
            {topic.isE2ee && <Lock className="h-3.5 w-3.5 shrink-0 text-accent2" />}
            <span className="truncate font-semibold">{topic.title}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <StatusPill mode={mode} />
            {mode === "p2p" && (
              <span className="flex items-center gap-1">
                <Users className="h-3 w-3" />
                {peerCount + 1} connected
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Queue banner */}
      {mode === "queued" && <P2PQueueBanner position={queuePosition} />}

      {/* Fallback notice */}
      {mode === "fallback" && (
        <div className="flex items-center gap-3 border-b border-border bg-amber-900/20 px-4 py-2 text-sm text-amber-400">
          <ServerCrash className="h-4 w-4 shrink-0" />
          Channel is over peer limit — switched to encrypted server relay.
          {topic.p2pFallbackE2ee && <span className="ml-1 text-xs opacity-70">Messages are still E2EE.</span>}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && mode !== "queued" && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center text-muted">
            <Radio className="h-8 w-8 opacity-30" />
            <div>
              <p className="font-medium">P2P channel</p>
              <p className="text-sm">Messages are direct, volatile, and never stored.</p>
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} isOwn={msg.senderId === currentUser.id} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border px-4 py-3">
        {mode === "fallback" ? (
          <p className="text-sm text-muted text-center py-1">Fallback mode active — use E2EE relay to send messages.</p>
        ) : mode === "queued" ? (
          <p className="text-sm text-muted text-center py-1">Waiting for a spot to open…</p>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={mode === "connecting" ? "Connecting to peers…" : "Message (not stored)"}
              disabled={mode === "connecting"}
              rows={1}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="flex-1 resize-none rounded-xl border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent placeholder:text-muted disabled:opacity-50 max-h-32 overflow-y-auto"
              style={{ height: "auto" }}
              onInput={(e) => {
                const t = e.currentTarget;
                t.style.height = "auto";
                t.style.height = Math.min(t.scrollHeight, 128) + "px";
              }}
            />
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-white hover:opacity-90 disabled:opacity-40 transition"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ mode }: { mode: P2PMode }) {
  const map: Record<P2PMode, { label: string; cls: string }> = {
    connecting: { label: "Connecting…", cls: "text-yellow-500 animate-pulse" },
    p2p:        { label: "P2P",         cls: "text-green-500" },
    queued:     { label: "Queued",      cls: "text-accent" },
    fallback:   { label: "Relay",       cls: "text-amber-400" },
  };
  const { label, cls } = map[mode];
  return <span className={cls}>{label}</span>;
}

function MessageBubble({ msg, isOwn }: { msg: P2PMessage; isOwn: boolean }) {
  return (
    <div className={`flex gap-2 ${isOwn ? "flex-row-reverse" : ""}`}>
      <div className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${isOwn ? "bg-accent text-white rounded-tr-sm" : "bg-panel2 rounded-tl-sm"}`}>
        {!isOwn && <p className="mb-0.5 text-xs font-medium opacity-70">{msg.senderName}</p>}
        <p className="whitespace-pre-wrap break-words">{msg.text}</p>
        <p className={`mt-0.5 text-right text-[10px] opacity-50`}>
          {new Date(msg.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      </div>
    </div>
  );
}
