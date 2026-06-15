"use client";
import { apiFetch } from "@/lib/fetch";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, Plus, Search, Trash2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  BotMasterRow,
  type AdminBotRow,
} from "@/components/admin/BotMasterRow";
import { BotDetailPanel } from "@/components/admin/BotDetailPanel";

interface TopicRow {
  id: string;
  title: string;
  isE2ee: boolean;
}

interface Assignment {
  botId: string;
  topicId: string;
}

interface Props {
  bots: AdminBotRow[];
  topics: TopicRow[];
  assignments: Assignment[];
}

export function AdminBotsForm({
  bots: initialBots,
  topics,
  assignments: initialAssignments,
}: Props) {
  const router = useRouter();
  const [bots, setBots] = useState<AdminBotRow[]>(initialBots);
  const [assignments, setAssignments] = useState<Assignment[]>(initialAssignments);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [newBotName, setNewBotName] = useState("");
  const [creating, setCreating] = useState(false);
  const [revealedToken, setRevealedToken] = useState<{ botId: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bulk-selection state — Set<botId>. Mirrors AdminTopicsForm bulk-ops shape.
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(() => new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const filteredBots = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return bots;
    return bots.filter((b) => b.name.toLowerCase().includes(q));
  }, [bots, filter]);

  const allFilteredSelected =
    filteredBots.length > 0 && filteredBots.every((b) => bulkSelected.has(b.id));
  const someFilteredSelected =
    filteredBots.some((b) => bulkSelected.has(b.id)) && !allFilteredSelected;
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someFilteredSelected;
  }, [someFilteredSelected]);

  function toggleSelected(id: string, checked: boolean) {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleSelectAll(checked: boolean) {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (checked) for (const b of filteredBots) next.add(b.id);
      else for (const b of filteredBots) next.delete(b.id);
      return next;
    });
  }

  function clearBulkSelection() {
    setBulkSelected(new Set());
    setBulkError(null);
  }

  async function refetchBots() {
    const res = await apiFetch("/api/admin/bots/page-data");
    if (!res.ok) return;
    const data = (await res.json()) as { bots?: AdminBotRow[] };
    if (data.bots) setBots(data.bots);
  }

  async function bulkDelete() {
    const ids = Array.from(bulkSelected);
    if (ids.length === 0) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      // Server caps each bulk call at 200 ids. Chunk client-side so the user
      // can mass-delete arbitrarily large selections without seeing 400s.
      const CHUNK = 200;
      const deletedAll = new Set<string>();
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const res = await apiFetch("/api/admin/bots/bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "delete", ids: chunk }),
        });
        if (!res.ok) {
          const detail = await res.json().catch(() => null);
          console.error("[admin-bots] bulk delete failed", res.status, detail);
          throw new Error(
            `bulk delete failed (${res.status}: ${detail?.error ?? "unknown"})`,
          );
        }
        const data = (await res.json()) as { ok: boolean; deleted: number; ids: string[] };
        for (const id of data.ids) deletedAll.add(id);
      }
      setBots((prev) => prev.filter((b) => !deletedAll.has(b.id)));
      setAssignments((prev) => prev.filter((a) => !deletedAll.has(a.botId)));
      if (selectedId && deletedAll.has(selectedId)) setSelectedId(null);
      setBulkSelected(new Set());
      setBulkConfirmOpen(false);
      router.refresh();
    } catch (e) {
      setBulkError((e as Error).message ?? "Delete failed");
      // Keep selection so the user can retry.
    } finally {
      setBulkBusy(false);
    }
  }

  async function createBot() {
    if (!newBotName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/bots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newBotName.trim() }),
      });
      const data = (await res.json()) as { bot: AdminBotRow; token: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Failed to create bot");
        return;
      }
      setBots((prev) => [...prev, data.bot]);
      setRevealedToken({ botId: data.bot.id, token: data.token });
      setNewBotName("");
      setSelectedId(data.bot.id);
    } finally {
      setCreating(false);
    }
  }

  const selectedBot = useMemo(
    () => bots.find((b) => b.id === selectedId) ?? null,
    [bots, selectedId],
  );

  return (
    <>
      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div
        className="flex overflow-hidden rounded-xl border border-border"
        style={{ height: "min(calc(100vh - 12rem), 800px)" }}
      >
        {/* Master pane */}
        <div
          className={cn(
            "flex-col border-r border-border bg-panel",
            selectedBot
              ? "hidden md:flex md:w-80 md:shrink-0"
              : "flex w-full md:w-80 md:shrink-0",
          )}
        >
          {/* Header: select-all + new */}
          <div className="flex items-center justify-between gap-2 border-b border-border p-3">
            <div className="flex items-center gap-2">
              <input
                ref={selectAllRef}
                type="checkbox"
                className="accent-accent"
                aria-label="Select all bots"
                checked={allFilteredSelected}
                onChange={(e) => toggleSelectAll(e.target.checked)}
                disabled={filteredBots.length === 0}
              />
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Bots
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                value={newBotName}
                onChange={(e) => setNewBotName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void createBot()}
                placeholder="New bot name…"
                className="w-32 rounded-lg border border-border bg-panel2 px-2 py-1 text-xs outline-none placeholder:text-muted focus:border-accent"
              />
              <button
                type="button"
                onClick={() => void createBot()}
                disabled={creating || !newBotName.trim()}
                className="flex items-center gap-1 rounded-lg bg-accent px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                {creating ? "…" : "New"}
              </button>
            </div>
          </div>

          {/* Search */}
          <div className="border-b border-border p-2">
            <div className="flex items-center gap-1.5 rounded-lg bg-panel2 px-2 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter bots by name…"
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted"
              />
              {filter && (
                <button
                  type="button"
                  onClick={() => setFilter("")}
                  className="text-muted hover:text-text"
                  aria-label="Clear filter"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          {/* Bulk action bar */}
          {bulkSelected.size > 0 && (
            <div className="sticky top-0 z-10 flex flex-col gap-1.5 border-b border-border bg-panel2 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-text">
                  {bulkSelected.size} bot{bulkSelected.size === 1 ? "" : "s"} selected
                </span>
                <button
                  type="button"
                  onClick={clearBulkSelection}
                  disabled={bulkBusy}
                  className="text-xs text-muted underline-offset-2 hover:text-text hover:underline disabled:opacity-50"
                >
                  Clear
                </button>
              </div>
              <button
                type="button"
                onClick={() => setBulkConfirmOpen(true)}
                disabled={bulkBusy}
                className="flex items-center justify-center gap-1 rounded-lg border border-danger px-2 py-1 text-xs text-danger hover:bg-danger hover:text-white disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {bulkBusy ? "Deleting…" : "Delete selected"}
              </button>
              {bulkError && <p className="text-[11px] text-danger">{bulkError}</p>}
            </div>
          )}

          <div className="flex-1 overflow-y-auto">
            {filteredBots.length === 0 && (
              <p className="p-4 text-xs text-muted">
                {bots.length === 0
                  ? "No bots yet. Create one above."
                  : "No bots match the filter."}
              </p>
            )}
            {filteredBots.map((b) => (
              <BotMasterRow
                key={b.id}
                bot={b}
                checked={bulkSelected.has(b.id)}
                onToggleChecked={(checked) => toggleSelected(b.id, checked)}
                active={selectedId === b.id}
                onSelect={() => setSelectedId(b.id)}
              />
            ))}
          </div>
        </div>

        {/* Bulk delete confirmation modal */}
        {bulkConfirmOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm bulk delete bots"
          >
            <div className="w-full max-w-md rounded-xl border border-border bg-panel p-5 shadow-xl">
              <h5 className="mb-2 text-sm font-semibold">
                Delete {bulkSelected.size} bot{bulkSelected.size === 1 ? "" : "s"}?
              </h5>
              <p className="mb-4 text-xs text-muted">
                Delete {bulkSelected.size} bot{bulkSelected.size === 1 ? "" : "s"}? Their DMs,
                devices, OTKs, and topic memberships will be removed. This cannot be undone.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setBulkConfirmOpen(false)}
                  disabled={bulkBusy}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-text disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void bulkDelete()}
                  disabled={bulkBusy}
                  className="rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {bulkBusy ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Detail pane */}
        <div
          className={cn(
            "flex-1 overflow-y-auto bg-panel",
            selectedBot ? "flex" : "hidden md:flex",
            "flex-col",
          )}
        >
          {selectedBot ? (
            <BotDetailPanel
              key={selectedBot.id}
              bot={selectedBot}
              topics={topics}
              assignments={assignments}
              revealedToken={
                revealedToken?.botId === selectedBot.id ? revealedToken.token : null
              }
              onDismissToken={() => setRevealedToken(null)}
              onBack={() => setSelectedId(null)}
              setBots={setBots}
              setAssignments={setAssignments}
              setRevealedToken={setRevealedToken}
              setError={setError}
              onDeleted={(id) => {
                setBots((prev) => prev.filter((b) => b.id !== id));
                setAssignments((prev) => prev.filter((a) => a.botId !== id));
                setSelectedId(null);
              }}
              refetchBots={refetchBots}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-sm text-muted">
              <Bot className="h-8 w-8 opacity-50" />
              <p>Select a bot to view details</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
