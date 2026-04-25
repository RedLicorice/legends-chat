"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { WS_EVENTS } from "@legends/shared";
import { cn } from "@/lib/cn";
import type { Socket } from "socket.io-client";

interface Notification {
  id: string;
  type: "mention" | "reply";
  payload: {
    messageId: string;
    topicId: string;
    topicTitle: string;
    senderName: string;
    preview: string;
  };
  readAt: string | null;
  createdAt: string;
}

function timeAgo(date: string): string {
  const ms = Date.now() - new Date(date).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function NotificationBell({ socket }: { socket: Socket | null }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/user/notifications");
    if (!res.ok) return;
    const data = await res.json() as { items: Notification[]; unread: number };
    setItems(data.items);
    setUnread(data.unread);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!socket) return;
    const handler = (notif: Notification) => {
      setItems((prev) => [notif, ...prev].slice(0, 50));
      setUnread((n) => n + 1);
    };
    socket.on(WS_EVENTS.NOTIFICATION_NEW, handler);
    return () => { socket.off(WS_EVENTS.NOTIFICATION_NEW, handler); };
  }, [socket]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  async function openPanel() {
    setOpen((v) => !v);
    if (!open && unread > 0) {
      setUnread(0);
      setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
      await fetch("/api/user/notifications", { method: "PATCH" });
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={openPanel}
        className={cn("relative rounded-lg p-2 transition hover:bg-panel2 text-muted hover:text-text", open && "bg-panel2 text-accent")}
        title="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white leading-none">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-border bg-panel shadow-lg">
          <div className="border-b border-border px-4 py-2.5 text-sm font-semibold">Notifications</div>
          {items.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted">No notifications yet.</div>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              {items.map((n) => (
                <a
                  key={n.id}
                  href={`/t/${n.payload.topicId}`}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "flex flex-col gap-0.5 px-4 py-3 text-sm transition hover:bg-panel2",
                    !n.readAt && "bg-panel2/40",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn("text-xs font-semibold uppercase tracking-wide", n.type === "mention" ? "text-accent" : "text-accent2")}>
                      {n.type === "mention" ? "Mention" : "Reply"}
                    </span>
                    <span className="ml-auto text-xs text-muted">{timeAgo(n.createdAt)}</span>
                  </div>
                  <div className="font-medium">{n.payload.topicTitle}</div>
                  <div className="truncate text-muted">{n.payload.senderName}: {n.payload.preview}</div>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
