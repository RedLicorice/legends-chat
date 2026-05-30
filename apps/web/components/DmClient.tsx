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
  const endRef = useRef<HTMLDivElement>(null);

  const accepted = conversations.filter((c) => c.state === "accepted");
  const requests = conversations.filter((c) => c.state === "pending" && c.incoming);
  const visibleAccepted = tab === "bots" ? accepted.filter((c) => c.peer?.type === "bot") : accepted;

  const refreshList = useCallback(async () => {
    const r = await apiFetch("/api/dm");
    if (r.ok) { const d = (await r.json()) as { conversations: Conversation[] }; setConversations(d.conversations); }
  }, []);

  const openThread = useCallback(async (id: string) => {
    setActiveId(id);
    const r = await apiFetch(`/api/dm/${id}/messages`);
    if (r.ok) { const d = (await r.json()) as { messages: Message[] }; setMessages(d.messages); }
  }, []);

  useDmSocket(useCallback((m: DmIncoming) => {
    if (m.conversationId === activeId) setMessages((prev) => prev.some((x) => x.id === m.id) ? prev : [...prev, m]);
    refreshList();
  }, [activeId, refreshList]));

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

  async function startDm(peer: SearchHit) {
    const r = await apiFetch("/api/dm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ peerType: peer.type, peerId: peer.id }) });
    if (!r.ok) return;
    const d = (await r.json()) as { id: string };
    setQuery(""); setHits([]);
    await refreshList();
    await openThread(d.id);
  }

  async function send() {
    if (!activeId || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    const r = await apiFetch(`/api/dm/${activeId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (r.ok) { const d = (await r.json()) as { message: Message }; setMessages((prev) => prev.some((x) => x.id === d.message.id) ? prev : [...prev, d.message]); }
  }

  async function accept(id: string) {
    await apiFetch(`/api/dm/${id}/accept`, { method: "POST" });
    await refreshList();
    await openThread(id);
  }

  return (
    <div className="flex h-full">
      <aside className={cn("shrink-0 border-r border-border bg-panel p-3 space-y-3 overflow-y-auto md:w-72", activeId ? "hidden md:block" : "block w-full")}>
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
              {c.peer?.type === "bot" && <span className="ml-auto rounded bg-accent2/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent2">bot</span>}
            </button>
          ))}
          {visibleAccepted.length === 0 && <p className="px-3 py-2 text-xs text-muted">No conversations yet.</p>}
        </div>
      </aside>

      <section className={cn("min-w-0 flex-col md:flex md:flex-1", activeId ? "flex flex-1" : "hidden md:flex")}>
        {activeId ? (
          <>
            <button
              type="button"
              onClick={() => setActiveId(null)}
              className="md:hidden flex items-center gap-2 border-b border-border px-3 py-2 text-sm text-muted hover:bg-panel2"
            >
              <span aria-hidden>←</span> Back
            </button>
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
                <button type="submit" className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!draft.trim()}>Send</button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">Select a conversation or search for someone.</div>
        )}
      </section>
    </div>
  );
}
