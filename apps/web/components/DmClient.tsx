"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/fetch";
import { cn } from "@/lib/cn";
import { useDmSocket, type DmIncoming } from "@/hooks/useDmSocket";

type Conversation = {
  id: string;
  state: "pending" | "accepted" | "blocked";
  isE2ee: boolean;
  peer: { type: "user" | "bot"; id: string; displayName: string; avatarUrl: string | null } | null;
  lastMessageAt: string | null;
  incoming: boolean;
};
type Message = { id: string; conversationId: string; senderType: string; senderId: string; text: string; createdAt: string };
type SearchHit = { type: "user" | "bot"; id: string; displayName: string; avatarUrl: string | null };

// ---------------------------------------------------------------------------
// Helpers (defined outside component to avoid re-creation on every render)
// ---------------------------------------------------------------------------
function isEnvelope(s: string): boolean {
  return typeof s === "string" && s.startsWith('{"r":1') && s.endsWith("}");
}
function peerOf(c: Conversation): { type: "user" | "bot"; id: string } | null {
  return c.peer ? { type: c.peer.type, id: c.peer.id } : null;
}

export function DmClient({ initialConversations, currentUserId }: { initialConversations: Conversation[]; currentUserId: string }) {
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [tab, setTab] = useState<"all" | "bots">(() => {
    if (typeof window === "undefined") return "all";
    return new URLSearchParams(window.location.search).get("tab") === "bots" ? "bots" : "all";
  });
  // E2EE state
  const [e2eeReady, setE2eeReady] = useState(false);
  const [e2eeSetupNeeded, setE2eeSetupNeeded] = useState(false);
  const [e2eeError, setE2eeError] = useState<string | null>(null);
  const [requestE2EE, setRequestE2EE] = useState(false);
  const [myFingerprint, setMyFingerprint] = useState<string | null>(null);
  const [peerFingerprint, setPeerFingerprint] = useState<string | null>(null);
  const [showSafety, setShowSafety] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const conversationsRef = useRef(initialConversations);

  const accepted = conversations.filter((c) => c.state === "accepted");
  const requests = conversations.filter((c) => c.state === "pending" && c.incoming);
  const visibleAccepted = tab === "bots" ? accepted.filter((c) => c.peer?.type === "bot") : accepted;

  const refreshList = useCallback(async () => {
    const r = await apiFetch("/api/dm");
    if (r.ok) { const d = (await r.json()) as { conversations: Conversation[] }; setConversations(d.conversations); }
  }, []);

  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);

  const openThread = useCallback(async (id: string) => {
    setActiveId(id);
    // Reset E2EE state for the new thread
    setE2eeReady(false);
    setE2eeError(null);
    setPeerFingerprint(null);

    // Always read from the ref so we get the most-recent list even when the
    // closure was captured before a state update (e.g. after refreshList).
    const convSnapshot = conversationsRef.current;
    const conv = convSnapshot.find((c) => c.id === id);
    const peer = conv ? peerOf(conv) : null;

    // -----------------------------------------------------------------------
    // Step 2: E2EE setup gate
    // -----------------------------------------------------------------------
    if (conv?.isE2ee && peer && peer.type === "user") {
      const olm = await import("@/lib/dm-olm");
      const { created, identityKeys } = await olm.getOrCreateAccount();
      setMyFingerprint(identityKeys.ed25519);
      if (created) {
        setE2eeSetupNeeded(true);
        try {
          await olm.generateAndPublishKeys();
        } catch (e) {
          setE2eeError("could not publish encryption keys: " + (e as Error).message);
          setE2eeSetupNeeded(false);
          return;
        }
        setE2eeSetupNeeded(false);
      }
      setE2eeReady(true);

      // -----------------------------------------------------------------------
      // Step 3: Establish outbound session if needed
      // -----------------------------------------------------------------------
      if (!(await olm.hasSession(id, peer.id))) {
        const bundleRes = await apiFetch(`/api/user/keys/bundle?userId=${peer.id}`);
        if (!bundleRes.ok) {
          const err = (await bundleRes.json().catch(() => ({}))) as { error?: string };
          setE2eeError(err.error ?? "peer has not set up encryption yet");
          // Allow the thread to open; sends will fail until peer publishes.
        } else {
          const bundle = (await bundleRes.json()) as {
            olmIdentityCurve25519: string;
            olmIdentityEd25519: string;
            oneTimePrekey: { id: string; key: string } | null;
          };
          setPeerFingerprint(bundle.olmIdentityEd25519);
          try {
            await olm.openOutboundSession(id, peer.id, {
              olmIdentityCurve25519: bundle.olmIdentityCurve25519,
              olmIdentityEd25519: bundle.olmIdentityEd25519,
              oneTimePrekey: bundle.oneTimePrekey,
            });
          } catch (e) {
            setE2eeError((e as Error).message);
          }
        }
      }

      // Populate peerFingerprint on re-open of an existing session (fix #4).
      const peerEd = await olm.getPeerEd25519(id, peer.id);
      if (peerEd) setPeerFingerprint(peerEd);
    }

    // -----------------------------------------------------------------------
    // Fetch messages + decrypt history (Step 3 continued)
    // -----------------------------------------------------------------------
    const r = await apiFetch(`/api/dm/${id}/messages`);
    if (!r.ok) return;
    const d = (await r.json()) as { messages: Message[] };

    if (conv?.isE2ee && peer && peer.type === "user") {
      const olm = await import("@/lib/dm-olm");
      const decrypted = await Promise.all(
        d.messages.map(async (m) => {
          if (!isEnvelope(m.text)) return m;
          try {
            const text = await olm.decrypt(id, peer.id, m.text);
            return { ...m, text };
          } catch {
            return { ...m, text: "(decryption failed)" };
          }
        }),
      );
      setMessages(decrypted);
    } else {
      setMessages(d.messages);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Step 5: Decrypt incoming WS messages
  // -------------------------------------------------------------------------
  useDmSocket(useCallback(async (m: DmIncoming) => {
    if (m.conversationId !== activeId) { refreshList(); return; }
    const conv = conversationsRef.current.find((c) => c.id === activeId);
    const peer = conv ? peerOf(conv) : null;
    let text = m.text;
    if (conv?.isE2ee && peer && peer.type === "user" && isEnvelope(text) && m.senderId !== currentUserId) {
      try {
        const olm = await import("@/lib/dm-olm");
        text = await olm.decrypt(activeId, peer.id, text);
      } catch { text = "(decryption failed)"; }
    }
    setMessages((prev) => prev.some((x) => x.id === m.id) ? prev : [...prev, { ...m, text }]);
    refreshList();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, refreshList, currentUserId]));

  useEffect(() => { endRef.current?.scrollIntoView(); }, [messages]);

  // debounce search
  useEffect(() => {
    if (query.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(async () => {
      const r = await apiFetch(`/api/dm/search?q=${encodeURIComponent(query.trim())}`);
      if (r.ok) setHits((await r.json()) as SearchHit[]);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // -------------------------------------------------------------------------
  // Step 6: startDm with E2EE toggle
  // -------------------------------------------------------------------------
  async function startDm(peer: SearchHit) {
    const wantE2EE = requestE2EE && peer.type === "user";
    const r = await apiFetch("/api/dm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peerType: peer.type, peerId: peer.id, e2ee: wantE2EE }),
    });
    if (!r.ok) {
      const err = (await r.json().catch(() => ({}))) as { error?: string };
      alert(err.error ?? "could not open DM");
      return;
    }
    const d = (await r.json()) as { id: string };
    setQuery(""); setHits([]); setRequestE2EE(false);
    await refreshList();
    await openThread(d.id);
  }

  // -------------------------------------------------------------------------
  // Step 4: send() with E2EE encrypt branch
  // -------------------------------------------------------------------------
  async function send() {
    if (!activeId || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    const conv = conversations.find((c) => c.id === activeId);
    const peer = conv ? peerOf(conv) : null;
    let body: string;
    if (conv?.isE2ee && peer && peer.type === "user") {
      try {
        const olm = await import("@/lib/dm-olm");
        body = await olm.encrypt(activeId, peer.id, text);
      } catch (e) {
        setE2eeError("encrypt failed: " + (e as Error).message);
        return;
      }
    } else {
      body = text;
    }
    const r = await apiFetch(`/api/dm/${activeId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body }),
    });
    if (!r.ok) return;
    const d = (await r.json()) as { message: Message };
    // Store plaintext optimistically (we just sent it). Dedup by id.
    setMessages((prev) => prev.some((x) => x.id === d.message.id) ? prev : [...prev, { ...d.message, text }]);
  }

  async function accept(id: string) {
    await apiFetch(`/api/dm/${id}/accept`, { method: "POST" });
    await refreshList();
    await openThread(id);
  }

  // Active conversation for the section header and banners
  const activeConv = conversations.find((c) => c.id === activeId);

  return (
    <>
      <div className="flex h-full">
        <aside className={cn("shrink-0 border-r border-border bg-panel p-3 space-y-3 overflow-y-auto md:w-72", activeId ? "hidden md:block" : "block w-full")}>
          {/* Step 6: Encrypted toggle */}
          <label className="flex items-center gap-2 px-1 text-xs text-muted">
            <input
              type="checkbox"
              checked={requestE2EE}
              onChange={(e) => setRequestE2EE(e.target.checked)}
              className="accent-accent"
            />
            Encrypted (user-to-user)
          </label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people…"
            className="w-full rounded-lg bg-panel2 px-3 py-2 text-sm outline-none placeholder:text-muted"
          />
          {hits.length > 0 && (
            <div className="rounded-lg border border-border bg-panel2">
              {hits.map((h) => (
                <button key={`${h.type}:${h.id}`} onClick={() => startDm(h)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-panel">
                  {h.displayName}
                  {h.type === "bot" && <span className="ml-auto rounded bg-accent2/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent2">bot</span>}
                </button>
              ))}
            </div>
          )}
          {requests.length > 0 && (
            <div>
              <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-widest text-muted">Requests</p>
              {requests.map((c) => (
                <div key={c.id} className="flex items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-panel2">
                  <span>{c.peer?.displayName ?? "Unknown"}</span>
                  <button onClick={() => accept(c.id)} className="rounded bg-accent px-2 py-1 text-xs font-medium text-white">Accept</button>
                </div>
              ))}
            </div>
          )}
          <div>
            <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-widest text-muted">Direct Messages</p>
            {visibleAccepted.map((c) => (
              <button key={c.id} onClick={() => openThread(c.id)} className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-panel2", activeId === c.id && "bg-panel2")}>
                <span className="truncate">{c.peer?.displayName ?? "Unknown"}</span>
                {/* Lock indicator for E2EE conversations */}
                {c.isE2ee && <span title="end-to-end encrypted" aria-label="encrypted" className="text-accent2">🔒</span>}
                {c.peer?.type === "bot" && <span className="ml-auto rounded bg-accent2/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent2">bot</span>}
              </button>
            ))}
            {visibleAccepted.length === 0 && <p className="px-3 py-2 text-xs text-muted">No conversations yet.</p>}
          </div>
        </aside>

        <section className={cn("min-w-0 flex-col md:flex md:flex-1", activeId ? "flex flex-1" : "hidden md:flex")}>
          {activeId ? (
            <>
              {/* Mobile back button row + optional Verify button */}
              <div className="md:hidden flex items-center border-b border-border">
                <button
                  type="button"
                  onClick={() => setActiveId(null)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-muted hover:bg-panel2"
                >
                  <span aria-hidden>←</span> Back
                </button>
                {(() => {
                  if (!activeConv?.isE2ee) return null;
                  return (
                    <>
                      {e2eeSetupNeeded && <span className="px-2 text-xs text-muted">Setting up encryption…</span>}
                      <button
                        type="button"
                        onClick={() => setShowSafety(true)}
                        className="ml-auto flex items-center gap-1 px-3 py-2 text-xs text-accent2"
                      >🔒 Verify</button>
                    </>
                  );
                })()}
              </div>
              {/* Desktop E2EE header bar */}
              {activeConv?.isE2ee && (
                <div className="hidden md:flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted">
                  <span className="text-accent2">🔒</span> end-to-end encrypted
                  {e2eeSetupNeeded && <span className="text-muted">Setting up encryption…</span>}
                  <button type="button" onClick={() => setShowSafety(true)} className="ml-auto rounded bg-panel2 px-2 py-1 text-xs hover:bg-panel">Verify identity</button>
                </div>
              )}
              {/* Setup gate banner */}
              {e2eeSetupNeeded && (
                <div className="border-b border-border bg-panel2 px-4 py-2 text-xs text-muted">
                  Setting up encryption…
                </div>
              )}
              {/* E2EE error banner */}
              {e2eeError && (
                <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
                  {e2eeError}
                  <button type="button" onClick={() => setE2eeError(null)} className="ml-2 underline">dismiss</button>
                </div>
              )}
              <div className="flex-1 space-y-2 overflow-y-auto p-4">
                {messages.map((m) => (
                  <div key={m.id} className={cn("max-w-[70%] rounded-xl px-3 py-2 text-sm", m.senderId === currentUserId ? "ml-auto bg-accent text-white" : "bg-panel2 text-text")}>
                    {m.text}
                  </div>
                ))}
                <div ref={endRef} />
              </div>
              <div className="border-t border-border p-3">
                <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex gap-2">
                  <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message…" className="flex-1 rounded-lg bg-panel2 px-3 py-2 text-sm outline-none placeholder:text-muted" />
                  <button type="submit" className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!draft.trim() || (Boolean(activeConv?.isE2ee) && !e2eeReady)}>Send</button>
                </form>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted">Select a conversation or search for someone.</div>
          )}
        </section>
      </div>

      {/* Safety-number modal (portal-style fixed overlay) */}
      {showSafety && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={() => setShowSafety(false)}>
          <div className="rounded-2xl border border-border bg-panel p-5 max-w-md w-full space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">Verify identity</h2>
            <p className="text-xs text-muted">Compare these fingerprints with your peer out-of-band (in person or over a trusted channel). If they match, the encryption is established correctly.</p>
            <div className="space-y-2">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-muted">You</p>
                <code className="block break-all rounded bg-panel2 p-2 text-xs">{myFingerprint ?? "(loading)"}</code>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest text-muted">Peer</p>
                <code className="block break-all rounded bg-panel2 p-2 text-xs">{peerFingerprint ?? "(unknown — open the thread to fetch)"}</code>
              </div>
            </div>
            <button type="button" onClick={() => setShowSafety(false)} className="rounded-lg bg-accent2 px-3 py-2 text-sm text-white">Close</button>
          </div>
        </div>
      )}
    </>
  );
}
