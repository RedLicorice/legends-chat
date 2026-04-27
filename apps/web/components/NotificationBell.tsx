"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { io } from "socket.io-client";
import { Bell, Megaphone } from "lucide-react";
import { WS_EVENTS } from "@legends/shared";
import { cn } from "@/lib/cn";

interface Notification {
  id: string;
  type: "mention" | "reply" | "broadcast";
  payload: {
    messageId?: string | null;
    topicId?: string | null;
    topicSlug?: string | null;
    topicTitle?: string | null;
    senderName?: string;
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

export function NotificationBell({ align = "right" }: { align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMounted(true); }, []);

  const load = useCallback(async () => {
    const res = await fetch("/api/user/notifications");
    if (!res.ok) return;
    const data = await res.json() as { items: Notification[]; unread: number };
    setItems(data.items);
    setUnread(data.unread);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Own socket connection — bell is always in AppSidebar (no prop to thread through)
  useEffect(() => {
    const socket = io(window.location.origin, {
      withCredentials: true,
      transports: ["polling", "websocket"],
    });
    socket.on(WS_EVENTS.NOTIFICATION_NEW, (notif: Notification) => {
      setItems((prev) => [notif, ...prev].slice(0, 50));
      setUnread((n) => n + 1);
    });
    return () => { socket.disconnect(); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        btnRef.current && !btnRef.current.contains(target) &&
        panelRef.current && !panelRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  function computeStyle(): React.CSSProperties {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return {};
    const top = rect.bottom + 8;
    const panelWidth = Math.min(320, window.innerWidth - 16);
    if (align === "left") {
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8));
      return { position: "fixed", top, left, width: panelWidth, zIndex: 9999 };
    }
    const right = window.innerWidth - rect.right;
    const clampedRight = Math.max(8, Math.min(right, window.innerWidth - panelWidth - 8));
    return { position: "fixed", top, right: clampedRight, width: panelWidth, zIndex: 9999 };
  }

  async function openPanel() {
    const nextOpen = !open;
    setPanelStyle(computeStyle());
    setOpen(nextOpen);
    if (nextOpen && unread > 0) {
      setUnread(0);
      setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
      await fetch("/api/user/notifications", { method: "PATCH" });
    }
  }

  function renderItem(n: Notification) {
    const isUnread = !n.readAt;
    const baseClass = cn("flex flex-col gap-0.5 px-4 py-3 text-sm", isUnread && "bg-panel2/40");
    const typeLabel =
      n.type === "mention" ? "Mention" : n.type === "reply" ? "Reply" : "Broadcast";
    const typeColor =
      n.type === "mention" ? "text-accent" : n.type === "reply" ? "text-accent2" : "text-muted";

    const inner = (
      <>
        <div className="flex items-center gap-2">
          {n.type === "broadcast" && <Megaphone className="h-3 w-3 text-muted" />}
          <span className={cn("text-xs font-semibold uppercase tracking-wide", typeColor)}>
            {typeLabel}
          </span>
          <span className="ml-auto text-xs text-muted">{timeAgo(n.createdAt)}</span>
        </div>
        {n.payload.topicTitle && <div className="font-medium">{n.payload.topicTitle}</div>}
        <div className="truncate text-muted">
          {n.payload.senderName ? `${n.payload.senderName}: ` : ""}{n.payload.preview}
        </div>
      </>
    );

    const href =
      n.payload.topicSlug && n.payload.messageId
        ? `/t/${n.payload.topicSlug}?msg=${n.payload.messageId}`
        : null;

    if (href) {
      return (
        <a key={n.id} href={href} onClick={() => setOpen(false)}
          className={cn(baseClass, "transition hover:bg-panel2")}>
          {inner}
        </a>
      );
    }
    return <div key={n.id} className={baseClass}>{inner}</div>;
  }

  return (
    <div className="relative">
      <button
        ref={btnRef}
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

      {open && mounted && createPortal(
        <div
          ref={panelRef}
          style={panelStyle}
          className="rounded-xl border border-border bg-panel shadow-lg"
        >
          <div className="border-b border-border px-4 py-2.5 text-sm font-semibold">Notifications</div>
          {items.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted">No notifications yet.</div>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              {items.map((n) => renderItem(n))}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
