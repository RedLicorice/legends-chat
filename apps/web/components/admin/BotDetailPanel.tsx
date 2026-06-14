"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, ChevronLeft, Copy, RefreshCw, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/fetch";
import { cn } from "@/lib/cn";
import { ImageUploadButton } from "@/components/ImageUploadButton";
import { AdminBotsE2eeSection } from "@/components/views/admin/AdminBotsE2eeSection";
import { BotStatePill, type AdminBotRow } from "@/components/admin/BotMasterRow";

interface TopicRow {
  id: string;
  title: string;
  isE2ee: boolean;
}

interface Assignment {
  botId: string;
  topicId: string;
}

interface BotOverride {
  id: string;
  permission: string;
  effect: string;
  expiresAt: string | null;
}

export interface BotDetailPanelProps {
  bot: AdminBotRow;
  topics: TopicRow[];
  assignments: Assignment[];
  revealedToken: string | null;
  onDismissToken: () => void;
  onBack: () => void;
  setBots: React.Dispatch<React.SetStateAction<AdminBotRow[]>>;
  setAssignments: React.Dispatch<React.SetStateAction<Assignment[]>>;
  setRevealedToken: React.Dispatch<
    React.SetStateAction<{ botId: string; token: string } | null>
  >;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  onDeleted: (id: string) => void;
  refetchBots: () => Promise<void>;
}

export function BotDetailPanel({
  bot,
  topics,
  assignments,
  revealedToken,
  onDismissToken,
  onBack,
  setBots,
  setAssignments,
  setRevealedToken,
  setError,
  onDeleted,
  refetchBots,
}: BotDetailPanelProps) {
  const [saving, setSaving] = useState(false);
  const [editName, setEditName] = useState(bot.name);
  const [editDescription, setEditDescription] = useState(bot.description ?? "");
  const [editWebhook, setEditWebhook] = useState(bot.webhookUrl ?? "");

  // Role draft state.
  const [roleDraft, setRoleDraft] = useState(bot.role ?? "bot");
  const [roleExpiresDraft, setRoleExpiresDraft] = useState(
    bot.roleExpiresAt
      ? new Date(bot.roleExpiresAt as string).toISOString().slice(0, 16)
      : "",
  );
  const [roleFallbackDraft, setRoleFallbackDraft] = useState(bot.roleFallback ?? "");

  // Overrides (loaded per detail mount).
  const [overrides, setOverrides] = useState<BotOverride[]>([]);
  const [overridesLoading, setOverridesLoading] = useState(false);

  useEffect(() => {
    // Defensive resync when the parent's BotRow object changes for the same id
    // (the panel itself is keyed on bot.id so a different bot already remounts).
    setEditName(bot.name);
    setEditDescription(bot.description ?? "");
    setEditWebhook(bot.webhookUrl ?? "");
    setRoleDraft(bot.role ?? "bot");
    setRoleExpiresDraft(
      bot.roleExpiresAt
        ? new Date(bot.roleExpiresAt as string).toISOString().slice(0, 16)
        : "",
    );
    setRoleFallbackDraft(bot.roleFallback ?? "");
  }, [
    bot.id,
    bot.name,
    bot.description,
    bot.webhookUrl,
    bot.role,
    bot.roleExpiresAt,
    bot.roleFallback,
  ]);

  const loadOverrides = useCallback(async () => {
    setOverridesLoading(true);
    try {
      const res = await apiFetch(`/api/admin/bots/${bot.id}/permission-overrides`);
      const data = (await res.json()) as { overrides: BotOverride[] };
      setOverrides(data.overrides ?? []);
    } finally {
      setOverridesLoading(false);
    }
  }, [bot.id]);

  useEffect(() => {
    void loadOverrides();
  }, [loadOverrides]);

  const botAssignments = assignments.filter((a) => a.botId === bot.id);
  const assignedTopicIds = new Set(botAssignments.map((a) => a.topicId));

  async function patchBot(patch: Record<string, unknown>) {
    const res = await apiFetch(`/api/admin/bots/${bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = (await res.json()) as { bot: AdminBotRow; error?: string };
    if (!res.ok) {
      setError(data.error ?? "Failed to save");
      return;
    }
    setBots((prev) => prev.map((b) => (b.id === bot.id ? data.bot : b)));
  }

  async function saveBasics() {
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      if (editName !== bot.name) patch.name = editName;
      if ((editDescription || null) !== (bot.description ?? null))
        patch.description = editDescription || null;
      if ((editWebhook || null) !== (bot.webhookUrl ?? null))
        patch.webhookUrl = editWebhook || null;
      if (Object.keys(patch).length === 0) return;
      await patchBot(patch);
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive() {
    await patchBot({ isActive: !bot.isActive });
  }

  async function rotateToken() {
    if (!window.confirm("Rotate token? The current token will stop working immediately."))
      return;
    const res = await apiFetch(`/api/admin/bots/${bot.id}/rotate-token`, {
      method: "POST",
    });
    const data = (await res.json()) as { token: string; error?: string };
    if (!res.ok) {
      setError(data.error ?? "Failed to rotate token");
      return;
    }
    setRevealedToken({ botId: bot.id, token: data.token });
  }

  async function deleteBot() {
    if (!window.confirm("Delete this bot? All its messages will remain but unowned."))
      return;
    const res = await apiFetch(`/api/admin/bots/${bot.id}`, { method: "DELETE" });
    if (res.ok) onDeleted(bot.id);
  }

  async function addToTopic(topicId: string) {
    const res = await apiFetch(`/api/admin/topics/${topicId}/bots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: bot.id }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!res.ok) {
      setError(data.error ?? "Failed to assign bot");
      return;
    }
    setAssignments((prev) => [...prev, { botId: bot.id, topicId }]);
  }

  async function removeFromTopic(topicId: string) {
    const res = await apiFetch(`/api/admin/topics/${topicId}/bots/${bot.id}`, {
      method: "DELETE",
    });
    if (res.ok)
      setAssignments((prev) =>
        prev.filter((a) => !(a.botId === bot.id && a.topicId === topicId)),
      );
  }

  async function saveRole() {
    await patchBot({
      role: roleDraft,
      roleExpiresAt: roleExpiresDraft || null,
      roleFallback: roleFallbackDraft || null,
    });
  }

  return (
    <section aria-label={`${bot.name} details`} className="space-y-5 p-6">
      {/* Mobile back */}
      <button
        type="button"
        className="flex items-center gap-1 text-sm text-muted md:hidden"
        onClick={onBack}
      >
        <ChevronLeft className="h-4 w-4" /> Back
      </button>

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent2/20">
          {bot.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={bot.avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <Bot className="h-6 w-6 text-accent2" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{bot.name}</h2>
          <div className="flex items-center gap-2 text-xs text-muted">
            <BotStatePill bot={bot} />
            <span>·</span>
            <span className={bot.isActive ? "text-green-500" : "text-muted"}>
              {bot.isActive ? "active" : "inactive"}
            </span>
          </div>
        </div>
      </div>

      {/* Token reveal */}
      {revealedToken && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs">
          <p className="mb-2 font-medium text-yellow-600 dark:text-yellow-400">
            Save this token — it won&apos;t be shown again.
          </p>
          <div className="flex items-center gap-2 break-all rounded bg-panel2 px-2 py-1.5 font-mono">
            <span className="flex-1">{revealedToken}</span>
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(revealedToken)}
              title="Copy"
              aria-label="Copy token"
            >
              <Copy className="h-3.5 w-3.5 shrink-0 text-muted hover:text-text" />
            </button>
          </div>
          <button
            type="button"
            onClick={onDismissToken}
            className="mt-2 text-xs text-muted hover:text-text"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Avatar */}
      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
          Avatar
        </label>
        <div className="flex items-center gap-3">
          <ImageUploadButton
            bucket="avatars"
            onUploaded={(url) => {
              void patchBot({ avatarUrl: url });
            }}
            onError={setError}
          />
          {bot.avatarUrl && (
            <button
              type="button"
              className="text-xs text-muted hover:text-danger"
              onClick={() => void patchBot({ avatarUrl: null })}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {/* Basics */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
            Name
          </label>
          <input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="w-full rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
            Webhook URL
          </label>
          <input
            value={editWebhook}
            onChange={(e) => setEditWebhook(e.target.value)}
            placeholder="https://…"
            className="w-full rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none placeholder:text-muted focus:border-accent"
          />
        </div>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
          Description
        </label>
        <textarea
          value={editDescription}
          onChange={(e) => setEditDescription(e.target.value)}
          rows={2}
          placeholder="Short description shown to users"
          className="w-full resize-none rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none placeholder:text-muted focus:border-accent"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void saveBasics()}
          disabled={saving}
          className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => void rotateToken()}
          className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-text"
        >
          <RefreshCw className="h-3 w-3" /> Rotate token
        </button>
        <button
          type="button"
          onClick={() => void toggleActive()}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-text"
        >
          {bot.isActive ? "Deactivate" : "Activate"}
        </button>
      </div>

      {/* Bot Role */}
      <div className="border-t border-border pt-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Bot Role
        </h4>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-0.5 block text-xs text-muted">Role</label>
            <select
              className="rounded border border-border bg-panel px-2 py-1 text-sm"
              value={roleDraft}
              onChange={(e) => setRoleDraft(e.target.value)}
            >
              <option value="bot">bot</option>
              <option value="bot-extended">bot-extended</option>
            </select>
          </div>
          <div>
            <label className="mb-0.5 block text-xs text-muted">Expires (optional)</label>
            <input
              type="datetime-local"
              className="rounded border border-border bg-panel px-2 py-1 text-sm"
              value={roleExpiresDraft}
              onChange={(e) => setRoleExpiresDraft(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-0.5 block text-xs text-muted">Reverts to</label>
            <select
              className="rounded border border-border bg-panel px-2 py-1 text-sm"
              value={roleFallbackDraft}
              onChange={(e) => setRoleFallbackDraft(e.target.value)}
            >
              <option value="">— none —</option>
              <option value="bot">bot</option>
              <option value="bot-extended">bot-extended</option>
            </select>
          </div>
          <button
            type="button"
            className="rounded bg-accent px-3 py-1.5 text-sm text-white"
            onClick={() => void saveRole()}
          >
            Save role
          </button>
        </div>
      </div>

      {/* E2EE state machine */}
      <div className="border-t border-border pt-4">
        <AdminBotsE2eeSection
          bot={{
            id: bot.id,
            e2ee_state: bot.e2ee_state,
            e2ee_device_id: bot.e2ee_device_id,
            identityKeyFingerprint: bot.identityKeyFingerprint,
            lastKeysUploadAt: bot.lastKeysUploadAt,
          }}
          onChange={refetchBots}
        />
      </div>

      {/* Permission Overrides */}
      <div className="border-t border-border pt-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Permission Overrides
        </h4>
        {overridesLoading ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : (
          <>
            {overrides.length > 0 && (
              <table className="mb-3 w-full text-xs">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="pb-1 pr-2">Permission</th>
                    <th className="pb-1 pr-2">Effect</th>
                    <th className="pb-1 pr-2">Expires</th>
                    <th className="pb-1" />
                  </tr>
                </thead>
                <tbody>
                  {overrides.map((o) => (
                    <tr
                      key={o.permission}
                      className={
                        o.expiresAt && new Date(o.expiresAt) < new Date()
                          ? "opacity-40"
                          : ""
                      }
                    >
                      <td className="py-0.5 pr-2 font-mono text-[11px]">
                        {o.permission}
                      </td>
                      <td
                        className={cn(
                          "py-0.5 pr-2 font-medium",
                          o.effect === "allow" ? "text-green-500" : "text-red-500",
                        )}
                      >
                        {o.effect}
                      </td>
                      <td className="py-0.5 pr-2">
                        {o.expiresAt
                          ? new Date(o.expiresAt).toLocaleDateString()
                          : "—"}
                      </td>
                      <td className="py-0.5">
                        <button
                          type="button"
                          className="text-muted transition hover:text-red-500"
                          onClick={async () => {
                            await apiFetch(
                              `/api/admin/bots/${bot.id}/permission-overrides`,
                              {
                                method: "DELETE",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ permission: o.permission }),
                              },
                            );
                            setOverrides((ov) =>
                              ov.filter((x) => x.permission !== o.permission),
                            );
                          }}
                          aria-label={`Delete override ${o.permission}`}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <BotAddOverrideForm
              onAdd={async (permission, effect, expiresAt) => {
                const res = await apiFetch(
                  `/api/admin/bots/${bot.id}/permission-overrides`,
                  {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ permission, effect, expiresAt }),
                  },
                );
                const data = (await res.json()) as { override: BotOverride };
                setOverrides((ov) => [
                  ...ov.filter((x) => x.permission !== permission),
                  data.override,
                ]);
              }}
            />
          </>
        )}
      </div>

      {/* Topic assignments */}
      <div className="border-t border-border pt-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Assigned Topics
        </h4>
        <div className="space-y-1">
          {topics.length === 0 && (
            <p className="text-xs text-muted">No topics available.</p>
          )}
          {topics.map((t) => {
            const assigned = assignedTopicIds.has(t.id);
            return (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-panel2"
              >
                <span className="text-xs">
                  {t.title}
                  {t.isE2ee && (
                    <span className="ml-1 text-[10px] text-muted">
                      (E2EE — bots excluded)
                    </span>
                  )}
                </span>
                {t.isE2ee ? null : assigned ? (
                  <button
                    type="button"
                    onClick={() => void removeFromTopic(t.id)}
                    className="text-xs text-danger hover:underline"
                  >
                    Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void addToTopic(t.id)}
                    className="text-xs text-accent hover:underline"
                  >
                    Add
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Danger zone */}
      <div className="border-t border-border pt-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-danger">
          Danger zone
        </h4>
        <button
          type="button"
          onClick={() => void deleteBot()}
          className="flex items-center gap-1 rounded-lg border border-danger/30 px-3 py-1.5 text-xs text-danger hover:bg-danger/10"
        >
          <Trash2 className="h-3 w-3" /> Delete bot
        </button>
      </div>
    </section>
  );
}

function BotAddOverrideForm({
  onAdd,
}: {
  onAdd: (
    permission: string,
    effect: string,
    expiresAt: string | null,
  ) => Promise<void>;
}) {
  const [permission, setPermission] = useState("");
  const [effect, setEffect] = useState("deny");
  const [expiresAt, setExpiresAt] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!permission.trim()) return;
    setSaving(true);
    try {
      await onAdd(permission.trim(), effect, expiresAt || null);
      setPermission("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <input
        className="w-52 rounded border border-border bg-panel px-2 py-1 font-mono text-xs"
        placeholder="permission string"
        value={permission}
        onChange={(e) => setPermission(e.target.value)}
      />
      <select
        className="rounded border border-border bg-panel px-2 py-1 text-xs"
        value={effect}
        onChange={(e) => setEffect(e.target.value)}
      >
        <option value="allow">allow</option>
        <option value="deny">deny</option>
      </select>
      <input
        type="datetime-local"
        className="rounded border border-border bg-panel px-2 py-1 text-xs"
        value={expiresAt}
        onChange={(e) => setExpiresAt(e.target.value)}
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={saving}
        className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50"
      >
        {saving ? "…" : "Add Override"}
      </button>
    </div>
  );
}
