"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { apiFetch } from "@/lib/fetch";
import { cn } from "@/lib/cn";
import { useDmSocket, type DmIncoming } from "@/hooks/useDmSocket";
import type { EncryptedEnvelope, IncomingEnvelope } from "@/lib/crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Server-provided view of the conversation row for this thread. */
export type DmThreadConversation = {
  id: string;
  isE2ee: boolean;
  e2eeRoomId: string | null;
  peer: { type: "user" | "bot"; id: string; displayName: string; avatarUrl: string | null } | null;
};

type Envelope = EncryptedEnvelope;

type Message = {
  id: string;
  conversationId: string;
  senderType: string;
  senderId: string;
  text: string;
  ciphertext: Record<string, unknown> | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bootstrappedKey(userId: string): string {
  return `legends-crypto-bootstrapped:${userId}`;
}

function toIncomingEnvelope(args: {
  envelope: Record<string, unknown>;
  matrixPeerUserId: string;
  messageId: string;
  createdAt: string;
}): IncomingEnvelope {
  return {
    type: "m.room.encrypted",
    sender: args.matrixPeerUserId,
    content: args.envelope as unknown as Envelope,
    event_id: `$${args.messageId}`,
    origin_server_ts: Date.parse(args.createdAt) || Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface DmThreadPaneProps {
  /** Conversation id (matches route segment `/dm/[id]`). */
  conversationId: string;
  currentUserId: string;
  /** Server-fetched conversation row — saves a round-trip on first render. */
  conversation: DmThreadConversation;
}

/**
 * Right-pane DM thread: history, composer, E2EE setup gate, crypto session
 * lifecycle, and incoming-message socket. The left-side conversation list and
 * request-acceptance UI live elsewhere now (ChatListPane + NotificationBell).
 */
export function DmThreadPane({ conversationId, currentUserId, conversation }: DmThreadPaneProps) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  // E2EE state
  const [e2eeReady, setE2eeReady] = useState(false);
  const [e2eeSetupNeeded, setE2eeSetupNeeded] = useState(false);
  const [e2eeError, setE2eeError] = useState<string | null>(null);
  const [myFingerprint, setMyFingerprint] = useState<string | null>(null);
  const [peerFingerprint, setPeerFingerprint] = useState<string | null>(null);
  const [showSafety, setShowSafety] = useState(false);
  // Decrypted plaintext cache keyed by message id.
  const [decryptedById, setDecryptedById] = useState<Record<string, string>>({});
  const decryptedRef = useRef(decryptedById);
  useEffect(() => { decryptedRef.current = decryptedById; }, [decryptedById]);

  const endRef = useRef<HTMLDivElement>(null);
  const cryptoRef = useRef<typeof import("@/lib/crypto") | null>(null);
  const sessionInitPromise = useRef<Promise<void> | null>(null);
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const peer = conversation.peer;
  const isE2eeThread = Boolean(
    conversation.isE2ee && peer && peer.type === "user" && conversation.e2eeRoomId,
  );

  // ---------------------------------------------------------------------------
  // Crypto session bootstrap (idempotent; safe to call repeatedly)
  // ---------------------------------------------------------------------------
  const ensureCrypto = useCallback(async (): Promise<typeof import("@/lib/crypto") | null> => {
    if (cryptoRef.current && e2eeReady) return cryptoRef.current;
    if (sessionInitPromise.current) {
      await sessionInitPromise.current;
      return cryptoRef.current;
    }
    sessionInitPromise.current = (async () => {
      try {
        const mod = await import("@/lib/crypto");
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
  // Lifecycle: poll /api/crypto/sync while visible, decrypt locked rows on
  // each tick. Releases the OlmMachine on unmount.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (interval) return;
      interval = setInterval(async () => {
        const mod = cryptoRef.current;
        if (!mod || !e2eeReady) return;
        try { await mod.pollSync(); } catch { return; }
        if (!isE2eeThread || !conversation.e2eeRoomId || !peer || peer.type !== "user") return;
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
            const text = await mod.decryptDm(conversation.e2eeRoomId, env);
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
  }, [e2eeReady, currentUserId, isE2eeThread, conversation.e2eeRoomId, peer]);

  // Release the OlmMachine ONLY on real unmount.
  useEffect(() => {
    return () => {
      cryptoRef.current?.freeResources().catch(() => {});
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Initial history load + decrypt (runs whenever conversationId changes,
  // i.e. on route change to a different /dm/[id]).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setE2eeError(null);
      setPeerFingerprint(null);

      if (isE2eeThread && peer) {
        const mod = await ensureCrypto();
        if (cancelled) return;
        if (!mod) return;
        try {
          await mod.ensurePeerTracked(peer.id);
          await mod.ensureSessionWithPeer(peer.id);
          const fp = await mod.getPeerFingerprint(peer.id);
          if (!cancelled) setPeerFingerprint(fp);
        } catch (e) {
          if (!cancelled) setE2eeError((e as Error).message);
        }
      }

      const r = await apiFetch(`/api/dm/${conversationId}/messages`);
      if (cancelled) return;
      if (!r.ok) return;
      const d = (await r.json()) as { messages: Message[]; e2eeRoomId: string | null; isE2ee: boolean };
      if (cancelled) return;
      setMessages(d.messages);

      if (isE2eeThread && d.e2eeRoomId && cryptoRef.current && peer) {
        const mod = cryptoRef.current;
        const matrixPeer = `@${peer.id}:legends.local`;
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
              // Locked row — pollSync will fill it in later.
            }
          }),
        );
        if (!cancelled && Object.keys(newly).length > 0) {
          setDecryptedById((prev) => ({ ...prev, ...newly }));
        }
      }
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [conversationId, isE2eeThread, peer, currentUserId, ensureCrypto]);

  // ---------------------------------------------------------------------------
  // Live incoming over socket.io
  // ---------------------------------------------------------------------------
  useDmSocket(useCallback(async (m: DmIncoming & { ciphertext?: Envelope | null }) => {
    if (m.conversationId !== conversationId) return;
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

    if (isE2eeThread && conversation.e2eeRoomId && peer && peer.type === "user" && incomingMsg.ciphertext && m.senderId !== currentUserId) {
      const mod = cryptoRef.current ?? (await ensureCrypto());
      if (!mod) return;
      try {
        const env = toIncomingEnvelope({
          envelope: incomingMsg.ciphertext,
          matrixPeerUserId: `@${peer.id}:legends.local`,
          messageId: incomingMsg.id,
          createdAt: incomingMsg.createdAt,
        });
        const text = await mod.decryptDm(conversation.e2eeRoomId, env);
        setDecryptedById((prev) => ({ ...prev, [incomingMsg.id]: text }));
      } catch {
        await mod.pollSync().catch(() => {});
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, currentUserId, ensureCrypto, isE2eeThread, conversation.e2eeRoomId, peer]));

  useEffect(() => { endRef.current?.scrollIntoView(); }, [messages, decryptedById]);

  // ---------------------------------------------------------------------------
  // Send (E2EE or plaintext)
  // ---------------------------------------------------------------------------
  async function send() {
    if (!draft.trim()) return;
    const text = draft.trim();
    setDraft("");

    if (isE2eeThread && peer && conversation.e2eeRoomId) {
      const mod = cryptoRef.current ?? (await ensureCrypto());
      if (!mod) {
        setE2eeError("encryption not initialized");
        return;
      }
      let envelope: Awaited<ReturnType<typeof mod.encryptDm>> | null = null;
      try {
        await mod.ensurePeerTracked(peer.id);
        await mod.ensureSessionWithPeer(peer.id);
        await mod.pumpOutgoing();
        envelope = await mod.encryptDm(conversation.e2eeRoomId, text);
      } catch (e) {
        try {
          await mod.pumpOutgoing();
          envelope = await mod.encryptDm(conversation.e2eeRoomId, text);
        } catch (e2) {
          setE2eeError("Encryption setup with peer in progress, try again in a moment. (" + (e2 as Error).message + ")");
          return;
        }
        if (!envelope) {
          setE2eeError("encrypt failed: " + (e as Error).message);
          return;
        }
      }
      const r = await apiFetch(`/api/dm/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ciphertext: envelope }),
      });
      if (!r.ok) return;
      const d = (await r.json()) as { message: Message };
      setDecryptedById((prev) => ({ ...prev, [d.message.id]: text }));
      setMessages((prev) => prev.some((x) => x.id === d.message.id) ? prev : [...prev, d.message]);
      return;
    }

    // Plaintext path
    const r = await apiFetch(`/api/dm/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return;
    const d = (await r.json()) as { message: Message };
    setMessages((prev) => prev.some((x) => x.id === d.message.id) ? prev : [...prev, { ...d.message, text }]);
  }

  return (
    <>
      <section className="flex h-full min-h-0 flex-1 flex-col">
        {/* Mobile back button row + optional Verify button */}
        <div className="md:hidden flex items-center border-b border-border">
          <button
            type="button"
            onClick={() => router.push("/?filter=dms")}
            className="flex items-center gap-2 px-3 py-2 text-sm text-muted hover:bg-panel2"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <div className="px-2 text-sm font-medium truncate">
            {peer?.displayName ?? "Conversation"}
          </div>
          {conversation.isE2ee && (
            <>
              {!e2eeReady && <span className="px-2 text-xs text-muted">Setting up encryption…</span>}
              <button
                type="button"
                onClick={() => setShowSafety(true)}
                className="ml-auto flex items-center gap-1 px-3 py-2 text-xs text-accent2"
              >🔒 Verify</button>
            </>
          )}
        </div>
        {/* Desktop header — peer name + optional E2EE controls */}
        <div className="hidden md:flex items-center gap-2 border-b border-border px-4 py-2 text-sm">
          <div className="font-medium truncate">{peer?.displayName ?? "Conversation"}</div>
          {conversation.isE2ee && (
            <>
              <span className="text-accent2 text-xs">🔒</span>
              <span className="text-xs text-muted">end-to-end encrypted</span>
              {!e2eeReady && <span className="text-xs text-muted">Setting up encryption…</span>}
              <button
                type="button"
                onClick={() => setShowSafety(true)}
                className="ml-auto rounded bg-panel2 px-2 py-1 text-xs hover:bg-panel"
              >Verify identity</button>
            </>
          )}
        </div>
        {/* Setup gate banner */}
        {conversation.isE2ee && e2eeSetupNeeded && !e2eeReady && (
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
            const isE2eeRow = conversation.isE2ee && m.ciphertext;
            const plaintext = isE2eeRow ? decryptedById[m.id] : m.text;
            const showLock = conversation.isE2ee;
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
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Message…"
              className="flex-1 rounded-lg bg-panel2 px-3 py-2 text-sm outline-none placeholder:text-muted"
            />
            <button
              type="submit"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={!draft.trim() || (conversation.isE2ee && !e2eeReady)}
            >Send</button>
          </form>
        </div>
      </section>

      {/* Safety-number modal */}
      {showSafety && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={() => setShowSafety(false)}>
          <div className="rounded-2xl border border-border bg-panel p-5 max-w-md w-full space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">
              Verify identity{peer ? ` with ${peer.displayName}` : ""}
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
