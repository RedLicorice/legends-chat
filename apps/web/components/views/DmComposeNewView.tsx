"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Menu, Send, X, Lock } from "lucide-react";
import { apiFetch } from "@/lib/fetch";
import { useAppShell } from "@/components/AppShell";
import { PWASplash } from "@/components/PWASplash";
import { useMe } from "@/lib/hooks/use-me";

/**
 * Compose view shown at `/c/new?peer=<userUuid>`. This is the new entry point
 * for user-to-user DMs: instead of pre-creating a `state='pending'` row on
 * "DM user" click and dumping the recipient into a "X wants to chat" screen
 * with nothing to read, the conversation row is only created when the sender
 * commits to a first message. The compose UI fetches just enough peer info
 * to render the header, then POSTs `/api/dm` with `{firstMessage:{text}}` and
 * navigates to the new `/c/<id>`.
 *
 * E2EE caveat: user-DM E2EE requires a conversation id to derive the room
 * key. Since the conversation doesn't exist until first-send, the very first
 * message is forced plaintext — encryption activates on follow-ups once the
 * recipient accepts. The "Encrypt this chat" affordance is therefore *not*
 * surfaced here; it's deferred until the convo exists. Existing
 * NewChatModal-driven user E2EE flows are likewise disabled (see
 * NewChatModal.tsx).
 */

interface PeerProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  bio: string | null;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export function DmComposeNewView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const peerId = searchParams?.get("peer") ?? "";
  const { openSidebar } = useAppShell();
  const { me, status: meStatus } = useMe();

  const [peer, setPeer] = useState<PeerProfile | null>(null);
  const [peerLoading, setPeerLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Pull peer info. Bail early if the query param is missing or malformed —
  // the route only makes sense with a target.
  useEffect(() => {
    if (!peerId) {
      setPeerLoading(false);
      return;
    }
    let cancelled = false;
    apiFetch(`/api/users/${peerId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: PeerProfile | null) => {
        if (cancelled) return;
        setPeer(data);
      })
      .catch(() => {
        // Network errors leave peer=null; the empty-state branch handles it.
      })
      .finally(() => {
        if (!cancelled) setPeerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [peerId]);

  // Focus the message field once peer info has loaded — focusing earlier
  // would race the loading spinner.
  useEffect(() => {
    if (!peerLoading && peer) {
      const t = setTimeout(() => textareaRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [peerLoading, peer]);

  const onSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || !peer) return;
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch("/api/dm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          peerType: "user",
          peerId: peer.id,
          // E2EE deliberately omitted from the v1 compose flow — see the
          // file header. The first message is plaintext; users opt in to
          // E2EE on the accepted conv via existing affordances.
          firstMessage: { text },
        }),
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: unknown };
        const code = typeof data.error === "string" ? data.error : "";
        if (code === "blocked" || r.status === 403) {
          setError("You can't message this user.");
        } else if (code === "first message required" || code === "cannot DM yourself") {
          setError(code);
        } else {
          setError("Couldn't send message. Try again.");
        }
        return;
      }
      const { id } = (await r.json()) as { id: string };
      // Tell the sidebar to re-fetch so the new conversation row appears.
      window.dispatchEvent(new CustomEvent("chatlist:refresh"));
      router.replace(`/c/${id}`);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }, [draft, peer, busy, router]);

  // Auth gate: this route requires a logged-in user. Mirror DMListView's
  // pattern so the same client-side redirect runs in the SPA.
  useEffect(() => {
    if (meStatus === "unauthenticated") {
      window.location.replace("/login");
    }
  }, [meStatus]);

  if (meStatus !== "authenticated") {
    return <PWASplash />;
  }

  if (!peerId) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-fg">
        <h1 className="text-xl font-semibold">No recipient</h1>
        <p className="text-sm text-muted">
          Open a user profile and use the &quot;DM user&quot; button to start a chat.
        </p>
        <a
          href="/"
          className="mt-2 rounded-md bg-panel2 px-3 py-1.5 text-sm hover:bg-panel"
        >
          Go home
        </a>
      </div>
    );
  }

  if (peerLoading) {
    return <PWASplash />;
  }

  if (!peer) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-fg">
        <h1 className="text-xl font-semibold">User not found</h1>
        <p className="text-sm text-muted">
          The person you&apos;re trying to message doesn&apos;t exist or can&apos;t be reached.
        </p>
        <a
          href="/"
          className="mt-2 rounded-md bg-panel2 px-3 py-1.5 text-sm hover:bg-panel"
        >
          Go home
        </a>
      </div>
    );
  }

  // Self-DM guard. The backend rejects this anyway (BAD), but a clean
  // client-side branch saves a round-trip and is friendlier.
  if (me && me.id === peer.id) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-fg">
        <h1 className="text-xl font-semibold">You can&apos;t DM yourself</h1>
        <a
          href="/"
          className="mt-2 rounded-md bg-panel2 px-3 py-1.5 text-sm hover:bg-panel"
        >
          Go home
        </a>
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-panel px-4 pb-4 pt-[calc(1rem+var(--sat))] md:px-6">
        <button
          type="button"
          onClick={openSidebar}
          className="shrink-0 rounded-md p-1 hover:bg-panel2 transition md:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="h-9 w-9 overflow-hidden rounded-full bg-accent2">
          {peer.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={peer.avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-white">
              {initialsOf(peer.displayName)}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{peer.displayName}</h1>
          <p className="text-xs text-muted">New conversation</p>
        </div>
        <button
          type="button"
          onClick={() => router.push("/")}
          className="rounded-md p-1 text-muted hover:bg-panel2 hover:text-text transition"
          aria-label="Cancel"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-panel p-6">
          <div className="space-y-2 text-center">
            <h2 className="text-base font-semibold">Send a message request</h2>
            <p className="text-sm text-muted">
              {peer.displayName} will see your first message and choose to accept,
              decline, or block. They can&apos;t reply until they accept.
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-md border border-border bg-panel2/50 p-3 text-xs text-muted">
            <Lock className="mt-0.5 h-3.5 w-3.5 flex-none" />
            <span>
              End-to-end encryption isn&apos;t available on the opening message.
              You can enable it after the recipient accepts.
            </span>
          </div>

          <div>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Cmd/Ctrl+Enter to send is the universal "I'm done typing"
                // affordance; matches ChatPane's composer.
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void onSend();
                }
              }}
              placeholder={`Message ${peer.displayName}`}
              rows={4}
              maxLength={8000}
              className="w-full resize-none rounded-lg bg-panel2 px-3 py-2 text-sm outline-none placeholder:text-muted focus:ring-1 focus:ring-accent"
              aria-label="First message"
            />
          </div>

          {error && (
            <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => router.push("/")}
              className="rounded-lg bg-panel2 px-3 py-2 text-sm font-medium hover:bg-panel transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onSend()}
              disabled={busy || draft.trim().length === 0}
              className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              {busy ? "Sending…" : "Send first message"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
