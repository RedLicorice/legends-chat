"use client";
import { apiFetch } from "@/lib/fetch";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { Bell, Megaphone, Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DmRequestPayload } from "@/lib/dm-requests";
import { useSessionBootstrap } from "@/contexts/SessionBootstrapContext";

// Mention/reply/broadcast share the same camelCase preview-style payload.
// dm_request rides on the same row but ships a snake_case payload mirrored
// from `lib/dm-requests.ts:DmRequestPayload`. We render-branch on `type`,
// so the payload union is intentionally loose — see `renderItem`.
type PreviewPayload = {
  messageId?: string | null;
  topicId?: string | null;
  topicSlug?: string | null;
  topicTitle?: string | null;
  senderName?: string;
  preview: string;
};

interface Notification {
  id: string;
  type: "mention" | "reply" | "broadcast" | "dm_request";
  payload: PreviewPayload | DmRequestPayload | Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
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
  const router = useRouter();
  const { bootstrap, markNotificationsRead } = useSessionBootstrap();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  // Per-notification action state for dm_request rows. Keyed by notif.id so
  // multiple pending requests can be acted on independently.
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<Record<string, string>>({});
  // Local optimistic mask: ids whose row we've collapsed (e.g. after
  // accept/decline) so they hide before the next bootstrap delta arrives.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMounted(true); }, []);

  // Items + unread now ride on the shared session bootstrap. NOTIFICATION_NEW
  // pushes through SessionBootstrapContext, which prepends to .items and
  // increments .unread — no per-bell socket or REST hit needed.
  const itemsRaw = (bootstrap?.notifications.items ?? []) as Notification[];
  const items = itemsRaw.filter((n) => !collapsed.has(n.id));
  const unread = bootstrap?.notifications.unread ?? 0;

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
      markNotificationsRead();
      await apiFetch("/api/user/notifications", { method: "PATCH" });
    }
  }

  // Mark a single dm_request row as collapsed after accept/decline. The
  // server already marked the underlying notification row read, and the
  // bulk "mark all" PATCH (above) also fires on panel-open — this just
  // hides the row optimistically.
  function markLocalRead(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  async function handleAccept(n: Notification, convId: string) {
    if (busy[n.id]) return;
    setBusy((b) => ({ ...b, [n.id]: true }));
    setActionError((e) => {
      const { [n.id]: _drop, ...rest } = e;
      return rest;
    });
    try {
      const res = await fetch(`/api/dm/${convId}/accept`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      markLocalRead(n.id);
      window.dispatchEvent(new CustomEvent("chatlist:refresh"));
      setOpen(false);
      router.push(`/c/${convId}`);
    } catch {
      setActionError((e) => ({ ...e, [n.id]: "Couldn't accept. Try again." }));
    } finally {
      setBusy((b) => {
        const { [n.id]: _drop, ...rest } = b;
        return rest;
      });
    }
  }

  async function handleDecline(n: Notification, convId: string) {
    if (busy[n.id]) return;
    setBusy((b) => ({ ...b, [n.id]: true }));
    setActionError((e) => {
      const { [n.id]: _drop, ...rest } = e;
      return rest;
    });
    try {
      const res = await fetch(`/api/dm/${convId}/decline`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      markLocalRead(n.id);
      window.dispatchEvent(new CustomEvent("chatlist:refresh"));
    } catch {
      setActionError((e) => ({ ...e, [n.id]: "Couldn't decline. Try again." }));
    } finally {
      setBusy((b) => {
        const { [n.id]: _drop, ...rest } = b;
        return rest;
      });
    }
  }

  function renderItem(n: Notification) {
    const isUnread = !n.readAt;
    const baseClass = cn("flex flex-col gap-0.5 px-4 py-3 text-sm", isUnread && "bg-panel2/40");

    // dm_request gets its own branch — distinct payload shape and inline
    // accept/decline actions instead of a passive click-through.
    if (n.type === "dm_request") {
      const p = n.payload as DmRequestPayload;
      const convId = p.conversation_id;
      const senderName = p.sender_display_name || "Someone";
      const avatarUrl = p.sender_avatar_url;
      const isE2ee = !!p.is_e2ee;
      const isBusy = !!busy[n.id];
      const err = actionError[n.id];

      const onBodyClick = (e: React.MouseEvent) => {
        // Ignore clicks that originated on the action buttons.
        if ((e.target as HTMLElement).closest("[data-dm-action]")) return;
        markLocalRead(n.id);
        setOpen(false);
        router.push(`/c/${convId}`);
      };

      return (
        <div
          key={n.id}
          className={cn(baseClass, "cursor-pointer transition hover:bg-panel2")}
          onClick={onBodyClick}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-accent">
              DM Request
            </span>
            <span className="ml-auto text-xs text-muted">{timeAgo(n.createdAt)}</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt=""
                className="h-7 w-7 flex-none rounded-full object-cover"
              />
            ) : (
              <div className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-panel2 text-[11px] font-semibold text-muted">
                {initialsOf(senderName)}
              </div>
            )}
            <div className="min-w-0 flex-1 text-sm">
              <strong className="font-semibold">{senderName}</strong>{" "}
              <span className="text-muted">wants to message you</span>
              {isE2ee && (
                <span className="ml-1 inline-flex items-center gap-0.5 text-muted" title="End-to-end encrypted">
                  <span aria-hidden>·</span>
                  <Lock className="h-3 w-3" aria-label="End-to-end encrypted" />
                </span>
              )}
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2" data-dm-action>
            <button
              type="button"
              data-dm-action
              disabled={isBusy}
              onClick={(e) => {
                e.stopPropagation();
                void handleAccept(n, convId);
              }}
              className={cn(
                "rounded-full bg-accent px-3 py-1 text-xs font-semibold text-white transition",
                isBusy ? "opacity-60" : "hover:opacity-90",
              )}
            >
              Accept
            </button>
            <button
              type="button"
              data-dm-action
              disabled={isBusy}
              onClick={(e) => {
                e.stopPropagation();
                void handleDecline(n, convId);
              }}
              className={cn(
                "rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted transition",
                isBusy ? "opacity-60" : "hover:bg-panel2 hover:text-text",
              )}
            >
              Decline
            </button>
            {err && <span className="ml-auto text-xs text-red-400">{err}</span>}
          </div>
        </div>
      );
    }

    const p = n.payload as PreviewPayload;
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
        {p.topicTitle && <div className="font-medium">{p.topicTitle}</div>}
        <div className="truncate text-muted">
          {p.senderName ? `${p.senderName}: ` : ""}{p.preview}
        </div>
      </>
    );

    const href =
      p.topicSlug && p.messageId
        ? `/t/${p.topicSlug}?msg=${p.messageId}`
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
        className={cn("relative rounded-lg p-1.5 transition hover:bg-panel2 text-muted hover:text-text", open && "bg-panel2 text-accent")}
        title="Notifications"
      >
        <Bell className="h-4 w-4" />
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
