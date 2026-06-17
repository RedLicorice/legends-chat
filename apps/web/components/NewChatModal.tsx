"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { Lock, Search, X, Bot, User as UserIcon } from "lucide-react";
import { apiFetch } from "@/lib/fetch";
import { cn } from "@/lib/cn";
import { Toggle } from "@/components/ui/Toggle";

// ---------------------------------------------------------------------------
// Types — mirror the `/api/dm/search` response shape
// ---------------------------------------------------------------------------

type SearchHit = {
  type: "user" | "bot";
  id: string;
  displayName: string;
  avatarUrl: string | null;
  // Only present for bot hits — surfaced so the modal can enable/disable the
  // E2EE checkbox. The server's POST /api/dm enforces the same gate.
  e2eeState?: "disabled" | "pending" | "ready";
};

interface NewChatModalProps {
  open: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export function NewChatModal({ open, onClose }: NewChatModalProps) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [requestE2EE, setRequestE2EE] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setMounted(true); }, []);

  // Reset state on open transitions so the modal re-opens clean. Also focus
  // the search input — same pattern as SearchModal / NotificationBell.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHits([]);
    setRequestE2EE(false);
    setBusyId(null);
    setError(null);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // Esc to close (mirrors NotificationBell's mousedown handler; here we want
  // the keyboard escape since the modal blocks the rest of the UI).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Debounced search — 150ms matches ChatListPane's filter debounce.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) { setHits([]); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await apiFetch(`/api/dm/search?q=${encodeURIComponent(q)}&limit=10`);
        if (r.ok) {
          setHits(((await r.json()) as SearchHit[]).slice(0, 10));
        } else {
          setHits([]);
        }
      } finally {
        setSearching(false);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [open, query]);

  const startChat = useCallback(async (hit: SearchHit) => {
    if (busyId) return;
    setError(null);
    setBusyId(hit.id);
    // User peers no longer create a conversation directly — they go to the
    // compose UI, which gathers a first message before POSTing /api/dm.
    // Bots still auto-accept and have no first-message gate, so the legacy
    // direct-POST path is preserved for them.
    if (hit.type === "user") {
      onClose();
      router.push(`/c/new?peer=${encodeURIComponent(hit.id)}`);
      setBusyId(null);
      return;
    }
    // Bot peer path. E2EE is gated on the bot's e2ee_state ("ready" only);
    // the server enforces the same constraint via BOT_E2EE_ERROR_CODES.
    const wantE2EE = requestE2EE && hit.e2eeState === "ready";
    try {
      const r = await apiFetch("/api/dm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ peerType: hit.type, peerId: hit.id, e2ee: wantE2EE }),
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: unknown };
        const msg =
          typeof data.error === "string"
            ? data.error
            : "Couldn't start chat. Try again.";
        setError(msg);
        return;
      }
      const { id } = (await r.json()) as { id: string };
      window.dispatchEvent(new CustomEvent("chatlist:refresh"));
      onClose();
      router.push(`/c/${id}`);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusyId(null);
    }
  }, [busyId, requestE2EE, onClose, router]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-stretch justify-center bg-black/50 md:items-start md:pt-24"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Start a new chat"
    >
      <div
        className={cn(
          "flex w-full max-w-md flex-col overflow-hidden bg-panel shadow-xl",
          "md:rounded-xl md:border md:border-border",
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="text-sm font-semibold">New chat</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md p-1 text-muted transition hover:bg-panel2 hover:text-text"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search input */}
        <div className="border-b border-border px-4 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name"
              className="w-full rounded-lg bg-panel2 pl-8 pr-3 py-2 text-sm outline-none placeholder:text-muted focus:ring-1 focus:ring-accent"
              aria-label="Search users and bots"
            />
          </div>

          {/* E2EE toggle. v1 caveat: user-to-user E2EE-from-first-message is
              not supported (the room key derives from the conversation id,
              which doesn't exist until first send), so the checkbox only
              applies to bot peers in the ready state. The compose flow for
              user peers always sends plaintext; users can enable E2EE later
              once the recipient accepts (out of scope here). */}
          {(() => {
            const anyE2eeCapable =
              hits.length === 0 ||
              hits.some((h) => h.type === "bot" && h.e2eeState === "ready");
            const onlyUsers =
              hits.length > 0 && hits.every((h) => h.type === "user");
            const disabled = hits.length > 0 && !anyE2eeCapable;
            const title = disabled
              ? onlyUsers
                ? "End-to-end encryption is enabled per-conversation after the recipient accepts."
                : "This bot isn't ready for end-to-end encryption yet."
              : undefined;
            return (
              <div
                className={cn(
                  "mt-3 flex items-center gap-2 text-xs text-muted",
                  disabled && "opacity-60",
                )}
                title={title}
              >
                <Toggle
                  checked={requestE2EE && !disabled}
                  disabled={disabled}
                  onChange={(next) => setRequestE2EE(next)}
                  aria-label="Encrypt this chat"
                />
                <Lock className="h-3 w-3" />
                <span>
                  {disabled
                    ? onlyUsers
                      ? "Encrypt this chat (enable after accept)"
                      : "Encrypt this chat (bot not ready)"
                    : "Encrypt this chat"}
                </span>
              </div>
            );
          })()}
        </div>

        {/* Results */}
        <div className="max-h-80 flex-1 overflow-y-auto">
          {error && (
            <div className="border-b border-border bg-red-500/10 px-4 py-2 text-xs text-red-400">
              {error}
            </div>
          )}
          {query.trim().length < 2 ? (
            <div className="px-4 py-6 text-center text-xs text-muted">
              Type at least 2 characters to search.
            </div>
          ) : searching && hits.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted">Searching…</div>
          ) : hits.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted">No matches.</div>
          ) : (
            <ul className="divide-y divide-border/60">
              {hits.map((h) => {
                const isBot = h.type === "bot";
                const isBusy = busyId === h.id;
                // Mirror startChat's gate: only bots in "ready" can ride the
                // first-send-with-E2EE path; users always send plaintext for
                // the opening message in v1.
                const isHitE2eeCapable =
                  h.type === "bot" && h.e2eeState === "ready";
                const wantE2EE = requestE2EE && isHitE2eeCapable;
                return (
                  <li key={`${h.type}:${h.id}`}>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void startChat(h)}
                      className={cn(
                        "flex w-full items-center gap-3 px-4 py-2.5 text-left transition",
                        isBusy ? "opacity-60" : "hover:bg-panel2",
                      )}
                    >
                      {h.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={h.avatarUrl}
                          alt=""
                          className="h-8 w-8 flex-none rounded-full object-cover"
                        />
                      ) : (
                        <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-panel2 text-[11px] font-semibold text-muted">
                          {initialsOf(h.displayName)}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{h.displayName}</div>
                        <div className="flex items-center gap-1 text-[11px] text-muted">
                          {isBot ? (
                            <>
                              <Bot className="h-3 w-3" /> Bot
                            </>
                          ) : (
                            <>
                              <UserIcon className="h-3 w-3" /> User
                            </>
                          )}
                          {wantE2EE && (
                            <>
                              <span aria-hidden>·</span>
                              <Lock className="h-3 w-3" />
                              <span>Encrypted</span>
                            </>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
