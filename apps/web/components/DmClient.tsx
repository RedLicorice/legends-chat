"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/fetch";
import { cn } from "@/lib/cn";
import { useDmSocket, type DmIncoming } from "@/hooks/useDmSocket";
import type { EncryptedEnvelope, IncomingEnvelope } from "@/lib/dm-crypto";

type Conversation = {
  id: string;
  state: "pending" | "accepted" | "blocked";
  isE2ee: boolean;
  e2eeRoomId: string | null;
  peer: { type: "user" | "bot"; id: string; displayName: string; avatarUrl: string | null } | null;
  lastMessageAt: string | null;
  incoming: boolean;
};
// Server stores the Matrix m.room.encrypted content as opaque JSON. We trust
// the OlmMachine to validate the shape when it deserialises it; locally we
// treat it as an EncryptedEnvelope for `decryptDm`.
type Envelope = EncryptedEnvelope;
type Message = {
  id: string;
  conversationId: string;
  senderType: string;
  senderId: string;
  text: string;
  // Server returns the persisted m.room.encrypted content as JSON. We narrow
  // to EncryptedEnvelope when handing off to the OlmMachine.
  ciphertext: Record<string, unknown> | null;
  createdAt: string;
};
type SearchHit = { type: "user" | "bot"; id: string; displayName: string; avatarUrl: string | null };

// ---------------------------------------------------------------------------
// Helpers (defined outside component to avoid re-creation on every render)
// ---------------------------------------------------------------------------
function peerOf(c: Conversation): { type: "user" | "bot"; id: string } | null {
  return c.peer ? { type: c.peer.type, id: c.peer.id } : null;
}

// localStorage key — once a user has successfully bootstrapped the crypto
// session at least once, suppress the setup-gate banner on subsequent visits.
function bootstrappedKey(userId: string): string {
  return `legends-crypto-bootstrapped:${userId}`;
}

// Build an IncomingEnvelope-shaped object for `decryptDm`. Matrix's OlmMachine
// requires a full m.room.encrypted event, so we synthesize one from the
// persisted DM row.
function toIncomingEnvelope(args: {
  envelope: Record<string, unknown>;
  matrixPeerUserId: string;
  messageId: string;
  createdAt: string;
}): IncomingEnvelope {
  return {
    type: "m.room.encrypted",
    sender: args.matrixPeerUserId,
    // The server-stored envelope was produced by `encryptDm`, which returns
    // an EncryptedEnvelope. The DB layer cast it to Record<string, unknown>
    // for storage; we trust it round-trips back to the same shape.
    content: args.envelope as unknown as Envelope,
    event_id: `$${args.messageId}`,
    origin_server_ts: Date.parse(args.createdAt) || Date.now(),
  };
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
  // Decrypted plaintext cache keyed by message id. Survives re-renders but is
  // wiped on unmount; live decryption is idempotent so re-fetching is cheap.
  const [decryptedById, setDecryptedById] = useState<Record<string, string>>({});
  // Ref mirror for closures that need the latest cache without re-binding.
  const decryptedRef = useRef(decryptedById);
  useEffect(() => { decryptedRef.current = decryptedById; }, [decryptedById]);

  const endRef = useRef<HTMLDivElement>(null);
  const conversationsRef = useRef(initialConversations);
  // Singleton across the component lifetime — set lazily on first need.
  const cryptoRef = useRef<typeof import("@/lib/dm-crypto") | null>(null);
  const sessionInitPromise = useRef<Promise<void> | null>(null);
  // Mirrors of state used inside the periodic-poll timer; updated via
  // separate effects below so the closure always sees the current values
  // without re-binding the interval every render.
  const messagesRef = useRef<Message[]>([]);
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  const accepted = conversations.filter((c) => c.state === "accepted");
  const requests = conversations.filter((c) => c.state === "pending" && c.incoming);
  const visibleAccepted = tab === "bots" ? accepted.filter((c) => c.peer?.type === "bot") : accepted;

  const refreshList = useCallback(async () => {
    const r = await apiFetch("/api/dm");
    if (r.ok) { const d = (await r.json()) as { conversations: Conversation[] }; setConversations(d.conversations); }
  }, []);

  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);

  // ---------------------------------------------------------------------------
  // Crypto session bootstrap (idempotent; safe to call repeatedly)
  // ---------------------------------------------------------------------------
  const ensureCrypto = useCallback(async (): Promise<typeof import("@/lib/dm-crypto") | null> => {
    if (cryptoRef.current && e2eeReady) return cryptoRef.current;
    if (sessionInitPromise.current) {
      await sessionInitPromise.current;
      return cryptoRef.current;
    }
    sessionInitPromise.current = (async () => {
      try {
        const mod = await import("@/lib/dm-crypto");
        cryptoRef.current = mod;
        const session = await mod.initCrypto(currentUserId);
        setMyFingerprint(session.fingerprint);
        await mod.bootstrap();
        setE2eeReady(true);
        setE2eeSetupNeeded(false);
        try { localStorage.setItem(bootstrappedKey(currentUserId), "1"); } catch {}
      } catch (e) {
        setE2eeError((e as Error).message);
        setE2eeSetupNeeded(true);
        throw e;
      } finally {
        sessionInitPromise.current = null;
      }
    })();
    try { await sessionInitPromise.current; } catch { return null; }
    return cryptoRef.current;
  }, [currentUserId, e2eeReady]);

  // ---------------------------------------------------------------------------
  // Lifecycle: poll /api/crypto/sync while visible, drain on socket event,
  // and release the OlmMachine on unmount.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (interval) return;
      interval = setInterval(async () => {
        const mod = cryptoRef.current;
        if (!mod || !e2eeReady) return;
        try {
          await mod.pollSync();
        } catch {
          return; // next tick retries
        }
        // After sync, retry decryption of any currently-locked messages in the
        // active thread. A freshly-arrived megolm room key turns a "🔒 ⚠️
        // Unable to decrypt" row into the plaintext on the next paint.
        const aId = activeIdRef.current;
        if (!aId) return;
        const conv = conversationsRef.current.find((c) => c.id === aId);
        const peer = conv ? peerOf(conv) : null;
        if (!conv?.isE2ee || !conv.e2eeRoomId || !peer || peer.type !== "user") return;
        const matrixPeer = `@${peer.id}:legends.local`;
        const newly: Record<string, string> = {};
        for (const m of messagesRef.current) {
          if (!m.ciphertext) continue;
          if (decryptedRef.current[m.id] != null) continue;
          try {
            const env = toIncomingEnvelope({
              envelope: m.ciphertext,
              matrixPeerUserId: m.senderId === currentUserId
                ? `@${currentUserId}:legends.local`
                : matrixPeer,
              messageId: m.id,
              createdAt: m.createdAt,
            });
            const text = await mod.decryptDm(conv.e2eeRoomId, env);
            newly[m.id] = text;
          } catch { /* still missing key */ }
        }
        if (Object.keys(newly).length > 0) {
          setDecryptedById((prev) => ({ ...prev, ...newly }));
        }
      }, 5000);
    };
    const stopPolling = () => {
      if (interval) { clearInterval(interval); interval = null; }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") startPolling(); else stopPolling();
    };
    if (typeof document !== "undefined") {
      onVisibility();
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      stopPolling();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [e2eeReady, currentUserId]);

  // Release the OlmMachine ONLY on real unmount. This effect has an empty
  // dependency list so the cleanup never runs in response to state changes
  // like `e2eeReady` flipping — otherwise we'd tear down the machine we just
  // initialised and the next send would hit "OlmMachine not initialized".
  useEffect(() => {
    return () => {
      cryptoRef.current?.freeResources().catch(() => {});
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Open thread: load history + decrypt E2EE messages.
  // ---------------------------------------------------------------------------
  const openThread = useCallback(async (id: string) => {
    setActiveId(id);
    setE2eeError(null);
    setPeerFingerprint(null);

    // Always read from the ref so we get the most-recent list even when the
    // closure was captured before a state update (e.g. after refreshList).
    const convSnapshot = conversationsRef.current;
    const conv = convSnapshot.find((c) => c.id === id);
    const peer = conv ? peerOf(conv) : null;
    const isE2ee = Boolean(conv?.isE2ee && peer && peer.type === "user" && conv.e2eeRoomId);

    if (isE2ee) {
      const mod = await ensureCrypto();
      if (!mod) return; // setup gate will surface; user will retry.
      // Track peer + ensure megolm session is ready (best-effort on open).
      try {
        await mod.ensurePeerTracked(peer!.id);
        await mod.ensureSessionWithPeer(peer!.id);
        const fp = await mod.getPeerFingerprint(peer!.id);
        setPeerFingerprint(fp);
      } catch (e) {
        // Peer may not have published keys yet — non-fatal; sends will retry.
        setE2eeError((e as Error).message);
      }
    }

    const r = await apiFetch(`/api/dm/${id}/messages`);
    if (!r.ok) return;
    const d = (await r.json()) as { messages: Message[]; e2eeRoomId: string | null; isE2ee: boolean };
    setMessages(d.messages);

    if (isE2ee && d.e2eeRoomId && cryptoRef.current) {
      // Decrypt history in parallel; each successful decrypt updates the cache.
      const mod = cryptoRef.current;
      const matrixPeer = `@${peer!.id}:legends.local`;
      const newly: Record<string, string> = {};
      await Promise.all(
        d.messages.map(async (m) => {
          if (!m.ciphertext) return;
          try {
            const env = toIncomingEnvelope({
              envelope: m.ciphertext,
              matrixPeerUserId: m.senderId === currentUserId
                ? `@${currentUserId}:legends.local`
                : matrixPeer,
              messageId: m.id,
              createdAt: m.createdAt,
            });
            const text = await mod.decryptDm(d.e2eeRoomId!, env);
            newly[m.id] = text;
          } catch {
            // leave undecrypted — UI shows the locked banner; pollSync will
            // pick up the missing room key and we'll retry on next render.
          }
        }),
      );
      if (Object.keys(newly).length > 0) {
        setDecryptedById((prev) => ({ ...prev, ...newly }));
      }
    }
  }, [currentUserId, ensureCrypto]);

  // ---------------------------------------------------------------------------
  // Live incoming over socket.io
  // ---------------------------------------------------------------------------
  useDmSocket(useCallback(async (m: DmIncoming & { ciphertext?: Envelope | null }) => {
    if (m.conversationId !== activeId) { refreshList(); return; }
    const conv = conversationsRef.current.find((c) => c.id === activeId);
    const peer = conv ? peerOf(conv) : null;
    const incomingMsg: Message = {
      id: m.id,
      conversationId: m.conversationId,
      senderType: m.senderType,
      senderId: m.senderId,
      text: m.text ?? "",
      ciphertext: m.ciphertext ?? null,
      createdAt: m.createdAt,
    };
    setMessages((prev) => prev.some((x) => x.id === incomingMsg.id) ? prev : [...prev, incomingMsg]);
    refreshList();

    // If this is an E2EE row not sent by us, decrypt asynchronously.
    if (conv?.isE2ee && conv.e2eeRoomId && peer && peer.type === "user" && incomingMsg.ciphertext && m.senderId !== currentUserId) {
      const mod = cryptoRef.current ?? (await ensureCrypto());
      if (!mod) return;
      try {
        const env = toIncomingEnvelope({
          envelope: incomingMsg.ciphertext,
          matrixPeerUserId: `@${peer.id}:legends.local`,
          messageId: incomingMsg.id,
          createdAt: incomingMsg.createdAt,
        });
        const text = await mod.decryptDm(conv.e2eeRoomId, env);
        setDecryptedById((prev) => ({ ...prev, [incomingMsg.id]: text }));
      } catch {
        // Likely missing room key — pollSync will eventually deliver it.
        await mod.pollSync().catch(() => {});
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, refreshList, currentUserId, ensureCrypto]));

  // Best-effort: subscribe to a `crypto:to_device` push if the server emits one.
  // The server may not emit this yet — that's fine, the interval poll covers
  // the gap. Kept as a hot-path optimization for when it lands.
  useEffect(() => {
    // We piggyback on the socket created by useDmSocket; there's no direct
    // handle to it here, so we open a thin secondary listener via dynamic
    // import. Scaffolded for future use; opt-in via window flag for now.
    // Intentionally left as a stub — see Plan B doc.
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView(); }, [messages, decryptedById]);

  // debounce search
  useEffect(() => {
    if (query.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(async () => {
      const r = await apiFetch(`/api/dm/search?q=${encodeURIComponent(query.trim())}`);
      if (r.ok) setHits((await r.json()) as SearchHit[]);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // ---------------------------------------------------------------------------
  // Start DM (with E2EE toggle)
  // ---------------------------------------------------------------------------
  async function startDm(peer: SearchHit) {
    const wantE2EE = requestE2EE && peer.type === "user";
    // If the user just toggled encryption on for the first time, eagerly init
    // so the setup gate runs before the new convo opens (better UX than
    // surfacing the gate banner immediately after the thread is open).
    if (wantE2EE) {
      await ensureCrypto();
    }
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

  // ---------------------------------------------------------------------------
  // Send (E2EE or plaintext)
  // ---------------------------------------------------------------------------
  async function send() {
    if (!activeId || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    const conv = conversations.find((c) => c.id === activeId);
    const peer = conv ? peerOf(conv) : null;
    const isE2ee = Boolean(conv?.isE2ee && peer && peer.type === "user" && conv.e2eeRoomId);

    if (isE2ee) {
      const mod = cryptoRef.current ?? (await ensureCrypto());
      if (!mod) {
        setE2eeError("encryption not initialized");
        return;
      }
      let envelope: Awaited<ReturnType<typeof mod.encryptDm>> | null = null;
      try {
        await mod.ensurePeerTracked(peer!.id);
        await mod.ensureSessionWithPeer(peer!.id);
        await mod.pumpOutgoing();
        envelope = await mod.encryptDm(conv!.e2eeRoomId!, text);
      } catch (e) {
        // One retry after a fresh pump — handles the "OTKs just landed" race.
        try {
          await mod.pumpOutgoing();
          envelope = await mod.encryptDm(conv!.e2eeRoomId!, text);
        } catch (e2) {
          setE2eeError("Encryption setup with peer in progress, try again in a moment. (" + (e2 as Error).message + ")");
          return;
        }
        if (!envelope) {
          setE2eeError("encrypt failed: " + (e as Error).message);
          return;
        }
      }
      const r = await apiFetch(`/api/dm/${activeId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ciphertext: envelope }),
      });
      if (!r.ok) return;
      const d = (await r.json()) as { message: Message };
      // Cache plaintext locally so we render it on echo without re-decrypting.
      setDecryptedById((prev) => ({ ...prev, [d.message.id]: text }));
      setMessages((prev) => prev.some((x) => x.id === d.message.id) ? prev : [...prev, d.message]);
      return;
    }

    // Plaintext path
    const r = await apiFetch(`/api/dm/${activeId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return;
    const d = (await r.json()) as { message: Message };
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
          {/* Encrypted toggle (Olm/Megolm) */}
          <label className="flex items-center gap-2 px-1 text-xs text-muted">
            <input
              type="checkbox"
              checked={requestE2EE}
              onChange={(e) => setRequestE2EE(e.target.checked)}
              className="accent-accent"
            />
            Encrypted (Olm/Megolm)
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
                      {!e2eeReady && <span className="px-2 text-xs text-muted">Setting up encryption…</span>}
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
                  {!e2eeReady && <span className="text-muted">Setting up encryption…</span>}
                  <button type="button" onClick={() => setShowSafety(true)} className="ml-auto rounded bg-panel2 px-2 py-1 text-xs hover:bg-panel">Verify identity</button>
                </div>
              )}
              {/* Setup gate banner: user hasn't opted in yet */}
              {activeConv?.isE2ee && e2eeSetupNeeded && !e2eeReady && (
                <div className="border-b border-border bg-panel2 px-4 py-3 text-xs text-muted flex items-center gap-2">
                  <span>Enable encryption to read and send messages in this thread.</span>
                  <button
                    type="button"
                    onClick={() => { ensureCrypto().catch(() => {}); }}
                    className="ml-auto rounded bg-accent2 px-3 py-1 text-xs text-white"
                  >Initialize</button>
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
                {messages.map((m) => {
                  // E2EE rendering: cached plaintext > placeholder
                  const isE2eeRow = activeConv?.isE2ee && m.ciphertext;
                  const plaintext = isE2eeRow ? decryptedById[m.id] : m.text;
                  const showLock = activeConv?.isE2ee;
                  if (isE2eeRow && plaintext == null) {
                    return (
                      <div key={m.id} className={cn("max-w-[70%] rounded-xl px-3 py-2 text-sm italic text-muted", m.senderId === currentUserId ? "ml-auto bg-accent/40" : "bg-panel2")}>
                        🔒 ⚠️ Unable to decrypt (waiting for sender&apos;s key)
                      </div>
                    );
                  }
                  return (
                    <div key={m.id} className={cn("max-w-[70%] rounded-xl px-3 py-2 text-sm", m.senderId === currentUserId ? "ml-auto bg-accent text-white" : "bg-panel2 text-text")}>
                      {showLock && <span className="mr-1 text-[10px] opacity-70" title="encrypted">🔒</span>}
                      {plaintext}
                    </div>
                  );
                })}
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
            <h2 className="text-lg font-semibold">
              Verify identity{activeConv?.peer ? ` with ${activeConv.peer.displayName}` : ""}
            </h2>
            <p className="text-xs text-muted">Compare these fingerprints with your peer out-of-band (in person or over a trusted channel). If they match, the encryption is established correctly.</p>
            <div className="space-y-2">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-muted">You</p>
                <code className="block break-all rounded bg-panel2 p-2 text-xs">{myFingerprint ?? "(loading)"}</code>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest text-muted">Peer</p>
                <code className="block break-all rounded bg-panel2 p-2 text-xs">
                  {peerFingerprint ?? "Peer has not enabled encryption yet."}
                </code>
              </div>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowSafety(false)} className="rounded-lg bg-accent2 px-3 py-2 text-sm text-white">Verify</button>
              <button type="button" onClick={() => setShowSafety(false)} className="rounded-lg bg-panel2 px-3 py-2 text-sm">Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
