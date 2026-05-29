"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/fetch";
import { cn } from "@/lib/cn";
import { useDmSocket, type DmIncoming } from "@/hooks/useDmSocket";

type Conversation = {
  id: string;
  state: "pending" | "accepted" | "blocked";
  isE2ee: boolean;
  peer: { id: string; displayName: string; avatarUrl: string | null } | null;
  lastMessageAt: string | null;
  incoming: boolean;
};
type Message = { id: string; conversationId: string; senderType: string; senderId: string; text: string; createdAt: string };
type SearchHit = { id: string; displayName: string; avatarUrl: string | null };

export function DmClient({ initialConversations, currentUserId }: { initialConversations: Conversation[]; currentUserId: string }) {
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const accepted = conversations.filter((c) => c.state === "accepted");
  const requests = conversations.filter((c) => c.state === "pending" && c.incoming);

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

  async function startDm(peerId: string) {
    const r = await apiFetch("/api/dm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ peerType: "user", peerId }) });
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
      <aside className="w-72 shrink-0 border-r border-border bg-panel p-3 space-y-3 overflow-y-auto">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people…"
          className="w-full rounded-lg bg-panel2 px-3 py-2 text-sm outline-none placeholder:text-muted"
        />
        {hits.length > 0 && (
          <div className="rounded-lg border border-border bg-panel2">
            {hits.map((h) => (
              <button key={h.id} onClick={() => startDm(h.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-panel">
                {h.displayName}
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
          {accepted.map((c) => (
            <button key={c.id} onClick={() => openThread(c.id)} className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-panel2", activeId === c.id && "bg-panel2")}>
              {c.peer?.displayName ?? "Unknown"}
            </button>
          ))}
          {accepted.length === 0 && <p className="px-3 py-2 text-xs text-muted">No conversations yet.</p>}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {activeId ? (
          <>
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
