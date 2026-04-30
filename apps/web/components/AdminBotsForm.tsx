"use client";
import { apiFetch } from "@/lib/fetch";

import { useState } from "react";
import { Bot, ChevronDown, ChevronUp, Copy, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { ImageUploadButton } from "@/components/ImageUploadButton";

interface BotRow {
  id: string;
  name: string;
  avatarUrl: string | null;
  description: string | null;
  webhookUrl: string | null;
  isActive: boolean;
  createdAt: Date | string;
}

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
  bots: BotRow[];
  topics: TopicRow[];
  assignments: Assignment[];
}

export function AdminBotsForm({ bots: initialBots, topics, assignments: initialAssignments }: Props) {
  const [bots, setBots] = useState<BotRow[]>(initialBots);
  const [assignments, setAssignments] = useState<Assignment[]>(initialAssignments);
  const [expandedBot, setExpandedBot] = useState<string | null>(null);
  const [newBotName, setNewBotName] = useState("");
  const [creating, setCreating] = useState(false);
  const [revealedToken, setRevealedToken] = useState<{ botId: string; token: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [editNames, setEditNames] = useState<Record<string, string>>({});
  const [editDescriptions, setEditDescriptions] = useState<Record<string, string>>({});
  const [editWebhooks, setEditWebhooks] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

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
      const data = await res.json() as { bot: BotRow; token: string; error?: string };
      if (!res.ok) { setError(data.error ?? "Failed to create bot"); return; }
      setBots((prev) => [...prev, data.bot]);
      setRevealedToken({ botId: data.bot.id, token: data.token });
      setNewBotName("");
      setExpandedBot(data.bot.id);
    } finally {
      setCreating(false);
    }
  }

  async function rotateToken(botId: string) {
    if (!window.confirm("Rotate token? The current token will stop working immediately.")) return;
    const res = await apiFetch(`/api/admin/bots/${botId}/rotate-token`, { method: "POST" });
    const data = await res.json() as { token: string; error?: string };
    if (!res.ok) { setError(data.error ?? "Failed to rotate token"); return; }
    setRevealedToken({ botId, token: data.token });
  }

  async function saveBot(botId: string) {
    setSaving(botId);
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      if (editNames[botId] !== undefined) patch.name = editNames[botId];
      if (editDescriptions[botId] !== undefined) patch.description = editDescriptions[botId] || null;
      if (editWebhooks[botId] !== undefined) patch.webhookUrl = editWebhooks[botId] || null;
      if (Object.keys(patch).length === 0) return;
      const res = await apiFetch(`/api/admin/bots/${botId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json() as { bot: BotRow; error?: string };
      if (!res.ok) { setError(data.error ?? "Failed to save"); return; }
      setBots((prev) => prev.map((b) => b.id === botId ? data.bot : b));
      setEditNames((prev) => { const n = { ...prev }; delete n[botId]; return n; });
      setEditDescriptions((prev) => { const n = { ...prev }; delete n[botId]; return n; });
      setEditWebhooks((prev) => { const n = { ...prev }; delete n[botId]; return n; });
    } finally {
      setSaving(null);
    }
  }

  async function toggleActive(bot: BotRow) {
    const res = await apiFetch(`/api/admin/bots/${bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: !bot.isActive }),
    });
    const data = await res.json() as { bot: BotRow };
    if (res.ok) setBots((prev) => prev.map((b) => b.id === bot.id ? data.bot : b));
  }

  async function deleteBot(botId: string) {
    if (!window.confirm("Delete this bot? All its messages will remain but unowned.")) return;
    const res = await apiFetch(`/api/admin/bots/${botId}`, { method: "DELETE" });
    if (res.ok) {
      setBots((prev) => prev.filter((b) => b.id !== botId));
      setAssignments((prev) => prev.filter((a) => a.botId !== botId));
    }
  }

  async function addToTopic(botId: string, topicId: string) {
    const res = await apiFetch(`/api/admin/topics/${topicId}/bots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId }),
    });
    const data = await res.json() as { ok: boolean; error?: string };
    if (!res.ok) { setError(data.error ?? "Failed to assign bot"); return; }
    setAssignments((prev) => [...prev, { botId, topicId }]);
  }

  async function removeFromTopic(botId: string, topicId: string) {
    const res = await apiFetch(`/api/admin/topics/${topicId}/bots/${botId}`, { method: "DELETE" });
    if (res.ok) setAssignments((prev) => prev.filter((a) => !(a.botId === botId && a.topicId === topicId)));
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger border border-danger/30">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)}><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* Create bot */}
      <div className="rounded-xl border border-border bg-panel p-5">
        <h2 className="mb-3 text-sm font-semibold">New Bot</h2>
        <div className="flex gap-2">
          <input
            value={newBotName}
            onChange={(e) => setNewBotName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createBot()}
            placeholder="Bot name"
            className="flex-1 rounded-lg bg-panel2 px-3 py-2 text-sm outline-none placeholder:text-muted"
          />
          <button
            type="button"
            onClick={createBot}
            disabled={creating || !newBotName.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> Create
          </button>
        </div>
      </div>

      {/* Bot list */}
      {bots.map((bot) => {
        const botAssignments = assignments.filter((a) => a.botId === bot.id);
        const assignedTopicIds = new Set(botAssignments.map((a) => a.topicId));
        const expanded = expandedBot === bot.id;

        return (
          <div key={bot.id} className="rounded-xl border border-border bg-panel overflow-hidden">
            <div className="flex items-center gap-3 px-5 py-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent2/20">
                {bot.avatarUrl
                  ? <img src={bot.avatarUrl} alt="" className="h-full w-full object-cover" />
                  : <Bot className="h-5 w-5 text-accent2" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm">{bot.name}</div>
                <div className={cn("text-xs", bot.isActive ? "text-green-500" : "text-muted")}>{bot.isActive ? "active" : "inactive"}</div>
              </div>
              <button type="button" onClick={() => setExpandedBot(expanded ? null : bot.id)} className="text-muted hover:text-text">
                {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
            </div>

            {expanded && (
              <div className="border-t border-border px-5 py-4 space-y-4">
                {/* Token reveal */}
                {revealedToken?.botId === bot.id && (
                  <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-3 text-xs">
                    <p className="mb-2 font-medium text-yellow-600 dark:text-yellow-400">Save this token — it won&apos;t be shown again.</p>
                    <div className="flex items-center gap-2 font-mono bg-panel2 rounded px-2 py-1.5 break-all">
                      <span className="flex-1">{revealedToken.token}</span>
                      <button type="button" onClick={() => void navigator.clipboard.writeText(revealedToken.token)} title="Copy">
                        <Copy className="h-3.5 w-3.5 text-muted hover:text-text shrink-0" />
                      </button>
                    </div>
                    <button type="button" onClick={() => setRevealedToken(null)} className="mt-2 text-xs text-muted hover:text-text">Dismiss</button>
                  </div>
                )}

                {/* Avatar */}
                <div>
                  <label className="text-xs text-muted mb-1 block">Avatar</label>
                  <div className="flex items-center gap-3">
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full bg-accent2/20 flex items-center justify-center">
                      {bot.avatarUrl
                        ? <img src={bot.avatarUrl} alt="" className="h-full w-full object-cover" />
                        : <Bot className="h-6 w-6 text-accent2" />
                      }
                    </div>
                    <ImageUploadButton
                      bucket="avatars"
                      onUploaded={(url) => {
                        apiFetch(`/api/admin/bots/${bot.id}`, {
                          method: "PATCH",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ avatarUrl: url }),
                        })
                          .then((r) => r.json())
                          .then((d: { bot: BotRow }) => setBots((prev) => prev.map((b) => b.id === bot.id ? d.bot : b)))
                          .catch(() => setError("Failed to save avatar"));
                      }}
                      onError={setError}
                    />
                    {bot.avatarUrl && (
                      <button
                        type="button"
                        className="text-xs text-muted hover:text-danger"
                        onClick={() => {
                          apiFetch(`/api/admin/bots/${bot.id}`, {
                            method: "PATCH",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ avatarUrl: null }),
                          })
                            .then((r) => r.json())
                            .then((d: { bot: BotRow }) => setBots((prev) => prev.map((b) => b.id === bot.id ? d.bot : b)))
                            .catch(() => {});
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>

                {/* Edit name */}
                <div>
                  <label className="text-xs text-muted mb-1 block">Name</label>
                  <input
                    value={editNames[bot.id] ?? bot.name}
                    onChange={(e) => setEditNames((p) => ({ ...p, [bot.id]: e.target.value }))}
                    className="w-full rounded-lg bg-panel2 px-3 py-1.5 text-sm outline-none"
                  />
                </div>

                {/* Description */}
                <div>
                  <label className="text-xs text-muted mb-1 block">Description</label>
                  <textarea
                    value={editDescriptions[bot.id] ?? (bot.description ?? "")}
                    onChange={(e) => setEditDescriptions((p) => ({ ...p, [bot.id]: e.target.value }))}
                    rows={2}
                    placeholder="Short description shown to users"
                    className="w-full rounded-lg bg-panel2 px-3 py-1.5 text-sm outline-none resize-none placeholder:text-muted"
                  />
                </div>

                {/* Webhook URL */}
                <div>
                  <label className="text-xs text-muted mb-1 block">Webhook URL</label>
                  <input
                    value={editWebhooks[bot.id] ?? (bot.webhookUrl ?? "")}
                    onChange={(e) => setEditWebhooks((p) => ({ ...p, [bot.id]: e.target.value }))}
                    placeholder="https://..."
                    className="w-full rounded-lg bg-panel2 px-3 py-1.5 text-sm outline-none placeholder:text-muted"
                  />
                </div>

                <div className="flex gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => saveBot(bot.id)}
                    disabled={saving === bot.id}
                    className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    {saving === bot.id ? "Saving…" : "Save"}
                  </button>
                  <button type="button" onClick={() => rotateToken(bot.id)} title="Rotate token"
                    className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-text">
                    <RefreshCw className="h-3 w-3" /> Rotate token
                  </button>
                  <button type="button" onClick={() => toggleActive(bot)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-text">
                    {bot.isActive ? "Deactivate" : "Activate"}
                  </button>
                  <button type="button" onClick={() => deleteBot(bot.id)}
                    className="ml-auto flex items-center gap-1 rounded-lg border border-danger/30 px-3 py-1.5 text-xs text-danger hover:bg-danger/10">
                    <Trash2 className="h-3 w-3" /> Delete
                  </button>
                </div>

                {/* Topic assignments */}
                <div>
                  <h3 className="text-xs font-semibold text-muted mb-2">Assigned Topics</h3>
                  <div className="space-y-1">
                    {topics.map((t) => {
                      const assigned = assignedTopicIds.has(t.id);
                      return (
                        <div key={t.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-panel2">
                          <span className="text-xs">{t.title}{t.isE2ee && <span className="ml-1 text-[10px] text-muted">(E2EE — bots excluded)</span>}</span>
                          {t.isE2ee ? null : assigned ? (
                            <button type="button" onClick={() => removeFromTopic(bot.id, t.id)} className="text-xs text-danger hover:underline">Remove</button>
                          ) : (
                            <button type="button" onClick={() => addToTopic(bot.id, t.id)} className="text-xs text-accent hover:underline">Add</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {bots.length === 0 && (
        <p className="text-sm text-muted text-center py-8">No bots yet. Create one above.</p>
      )}
    </div>
  );
}
