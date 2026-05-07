"use client";
import { apiFetch } from "@/lib/fetch";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Radio } from "lucide-react";
import { ImageUploadButton } from "@/components/ImageUploadButton";

interface TopicRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  isSticky: boolean;
  sortOrder: number;
  isFeed: boolean;
  isHomeTopic: boolean;
  isE2ee: boolean;
  isP2p: boolean;
  p2pFallbackE2ee: boolean;
  p2pMaxParticipants: number | null;
  viewRoles: string[];
  postRoles: string[];
  readRoles: string[];
  autoDeleteMode: "none" | "age" | "count";
  autoDeleteAgeSeconds: number | null;
  autoDeleteMaxMessages: number | null;
}

function secondsToDisplay(s: number | null): { value: string; unit: "hours" | "days" } {
  if (!s) return { value: "24", unit: "hours" };
  if (s >= 86400 && s % 86400 === 0) return { value: String(s / 86400), unit: "days" };
  return { value: String(Math.round(s / 3600)), unit: "hours" };
}

function RolesCheckboxes({
  roles,
  allRoles,
  onSave,
  disabled,
}: {
  roles: string[];
  allRoles: string[];
  onSave: (roles: string[]) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-3">
      {allRoles.map((role) => (
        <label key={role} className="flex cursor-pointer items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            className="accent-accent"
            checked={roles.length === 0 || roles.includes(role)}
            disabled={roles.length === 0 || disabled}
            onChange={(e) => {
              const next = e.target.checked ? [...roles, role] : roles.filter((r) => r !== role);
              onSave(next);
            }}
          />
          {role}
        </label>
      ))}
      <label className="flex cursor-pointer items-center gap-1.5 text-sm">
        <input
          type="checkbox"
          className="accent-accent"
          checked={roles.length === 0}
          disabled={disabled}
          onChange={(e) => onSave(e.target.checked ? [] : ["admin"])}
        />
        everyone
      </label>
    </div>
  );
}

type RetentionDraft = Record<string, { ageValue: string; ageUnit: "hours" | "days"; maxMessages: string }>;

const EMPTY_CREATE = { slug: "", title: "", description: "" };

export function AdminTopicsForm({ topics: initial }: { topics: TopicRow[] }) {
  const [topics, setTopics] = useState(initial);
  const [allRoles, setAllRoles] = useState<string[]>(["user", "moderator", "admin"]);
  const [saving, setSaving] = useState<string | null>(null);
  const [purging, setPurging] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [retentionDraft, setRetentionDraft] = useState<RetentionDraft>(() =>
    Object.fromEntries(
      initial.map((t) => {
        const age = secondsToDisplay(t.autoDeleteAgeSeconds);
        return [t.id, { ageValue: age.value, ageUnit: age.unit, maxMessages: String(t.autoDeleteMaxMessages ?? 1000) }];
      }),
    ),
  );
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState(EMPTY_CREATE);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    apiFetch("/api/admin/roles")
      .then((r) => r.ok ? r.json() : null)
      .then((data: { name: string }[] | null) => {
        if (!data) return;
        setAllRoles(data.map((r) => r.name));
      })
      .catch(() => {});
  }, []);

  async function save(id: string, patch: Partial<TopicRow>, extra?: Record<string, unknown>) {
    setSaving(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const res = await apiFetch(`/api/admin/topics/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...patch, ...extra }),
      });
      if (!res.ok) throw new Error("save failed");
      setTopics((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      router.refresh();
    } catch {
      setErrors((e) => ({ ...e, [id]: "Save failed" }));
    } finally {
      setSaving(null);
    }
  }

  async function toggleE2ee(id: string, enable: boolean) {
    if (enable) {
      const confirmed = window.confirm(
        "Enabling E2EE will permanently delete all existing messages in this topic. This cannot be undone.\n\nContinue?",
      );
      if (!confirmed) return;
      await save(id, { isE2ee: true }, { wipeMessages: true });
    } else {
      await save(id, { isE2ee: false });
    }
  }

  async function saveRetention(id: string) {
    const t = topics.find((t) => t.id === id)!;
    const draft = retentionDraft[id]!;
    const patch: Partial<TopicRow> = {};

    if (t.autoDeleteMode === "age") {
      const v = parseFloat(draft.ageValue);
      if (isNaN(v) || v <= 0) {
        setErrors((e) => ({ ...e, [id]: "Invalid age value" }));
        return;
      }
      patch.autoDeleteAgeSeconds = Math.round(v * (draft.ageUnit === "days" ? 86400 : 3600));
    } else if (t.autoDeleteMode === "count") {
      const v = parseInt(draft.maxMessages, 10);
      if (isNaN(v) || v <= 0) {
        setErrors((e) => ({ ...e, [id]: "Invalid count value" }));
        return;
      }
      patch.autoDeleteMaxMessages = v;
    }

    if (Object.keys(patch).length > 0) await save(id, patch);
  }

  async function purge(id: string) {
    setPurging(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const res = await apiFetch(`/api/admin/topics/${id}/messages`, { method: "DELETE" });
      if (!res.ok) throw new Error("purge failed");
    } catch {
      setErrors((e) => ({ ...e, [id]: "Purge failed" }));
    } finally {
      setPurging(null);
    }
  }

  async function deleteTopic(id: string, title: string) {
    if (!window.confirm(`Delete topic "${title}"? This cannot be undone.`)) return;
    setDeleting(id);
    try {
      const res = await apiFetch(`/api/admin/topics/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      setTopics((prev) => prev.filter((t) => t.id !== id));
      router.refresh();
    } catch {
      setErrors((e) => ({ ...e, [id]: "Delete failed" }));
    } finally {
      setDeleting(null);
    }
  }

  async function createTopic() {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiFetch("/api/admin/topics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: createForm.slug.trim(),
          title: createForm.title.trim(),
          description: createForm.description.trim() || undefined,
          isSticky: false,
          sortOrder: 0,
          isE2ee: false,
          historyVisibleToNewMembers: true,
          autoDeleteMode: "none",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCreateError(data.error?.formErrors?.[0] ?? "Create failed");
        return;
      }
      const t = data.topic;
      setTopics((prev) => [
        ...prev,
        {
          id: t.id,
          slug: t.slug,
          title: t.title,
          description: t.description,
          iconUrl: t.iconUrl ?? null,
          bannerUrl: t.bannerUrl ?? null,
          isSticky: t.isSticky,
          sortOrder: t.sortOrder,
          isFeed: t.isFeed,
          isHomeTopic: t.isHomeTopic,
          isE2ee: t.isE2ee,
          isP2p: t.isP2p ?? false,
          p2pFallbackE2ee: t.p2pFallbackE2ee ?? false,
          p2pMaxParticipants: t.p2pMaxParticipants ?? null,
          viewRoles: (t.viewRoles as string[] | null) ?? [],
          postRoles: (t.postRoles as string[] | null) ?? [],
          readRoles: (t.readRoles as string[] | null) ?? [],
          autoDeleteMode: t.autoDeleteMode,
          autoDeleteAgeSeconds: t.autoDeleteAgeSeconds,
          autoDeleteMaxMessages: t.autoDeleteMaxMessages,
        },
      ]);
      setRetentionDraft((d) => ({ ...d, [t.id]: { ageValue: "24", ageUnit: "hours", maxMessages: "1000" } }));
      setCreateForm(EMPTY_CREATE);
      setShowCreate(false);
      router.refresh();
    } catch {
      setCreateError("Create failed");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Create form */}
      {showCreate ? (
        <div className="rounded-xl border border-accent bg-panel p-5 space-y-3">
          <h2 className="text-sm font-semibold">New topic</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Title</label>
              <input
                value={createForm.title}
                onChange={(e) => setCreateForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="General"
                className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Slug</label>
              <input
                value={createForm.slug}
                onChange={(e) => setCreateForm((f) => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") }))}
                placeholder="general"
                className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent font-mono"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Description (optional)</label>
            <input
              value={createForm.description}
              onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="What this channel is for"
              className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>
          {createError && <p className="text-xs text-danger">{createError}</p>}
          <div className="flex gap-2">
            <button
              onClick={createTopic}
              disabled={creating || !createForm.slug || !createForm.title}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create topic"}
            </button>
            <button
              onClick={() => { setShowCreate(false); setCreateForm(EMPTY_CREATE); setCreateError(null); }}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-panel2"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-panel2"
        >
          <Plus className="h-4 w-4" /> New topic
        </button>
      )}

      {/* Topic list */}
      {topics.map((t) => {
        const draft = retentionDraft[t.id]!;
        const dis = saving === t.id || deleting === t.id;
        return (
          <div key={t.id} className="rounded-xl border border-border bg-panel p-5 space-y-4">
            {/* Header + toggles */}
            <div>
              <div className="mb-3 grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Title</label>
                  <InlineTextInput
                    value={t.title}
                    placeholder="General"
                    onSave={(v) => save(t.id, { title: v.trim() || t.title })}
                    disabled={dis}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Slug</label>
                  <InlineTextInput
                    value={t.slug}
                    placeholder="general"
                    onSave={(v) => save(t.id, { slug: v.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-") || t.slug })}
                    disabled={dis}
                    mono
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                {(["isFeed", "isHomeTopic", "isSticky"] as const).map((key) => (
                  <label key={key} className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={t[key] as boolean}
                      onChange={(e) => save(t.id, { [key]: e.target.checked })}
                      className="accent-accent"
                      disabled={dis}
                    />
                    {{ isFeed: "Feed", isHomeTopic: "Home", isSticky: "Sticky" }[key]}
                  </label>
                ))}
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={t.isE2ee}
                    onChange={(e) => toggleE2ee(t.id, e.target.checked)}
                    className="accent-accent"
                    disabled={dis}
                  />
                  E2EE
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={t.isP2p}
                    onChange={(e) => save(t.id, { isP2p: e.target.checked })}
                    className="accent-accent"
                    disabled={dis}
                  />
                  <Radio className="h-3.5 w-3.5" /> P2P
                </label>
                <button
                  onClick={() => deleteTopic(t.id, t.title)}
                  disabled={dis}
                  className="ml-auto flex items-center gap-1 rounded-lg border border-danger px-2 py-1 text-xs text-danger hover:bg-danger hover:text-white disabled:opacity-50"
                  title="Delete topic"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {deleting === t.id ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>

            {/* Icon URL */}
            <div className="border-t border-border pt-3">
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Icon</label>
              <div className="flex gap-2 items-start">
                {t.iconUrl && (
                  <img src={t.iconUrl} alt="" className="h-9 w-9 shrink-0 rounded object-cover bg-panel2 border border-border" />
                )}
                <InlineTextInput
                  value={t.iconUrl ?? ""}
                  placeholder="https://example.com/icon.png"
                  onSave={(v) => save(t.id, { iconUrl: v.trim() || null })}
                  disabled={dis}
                />
                <ImageUploadButton
                  bucket="avatars"
                  onUploaded={(url) => save(t.id, { iconUrl: url })}
                  onError={(err) => setErrors((e) => ({ ...e, [t.id]: err }))}
                  className="shrink-0 flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-text hover:bg-panel2 disabled:opacity-50"
                />
              </div>
              <p className="mt-1 text-xs text-muted">Square image shown as topic icon in the sidebar. Leave blank to use initials. JPEG, PNG, GIF, WebP · max 10 MB.</p>
            </div>

            {/* Banner URL */}
            <div className="border-t border-border pt-3">
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Banner</label>
              <div className="flex gap-2 items-start">
                <InlineTextInput
                  value={t.bannerUrl ?? ""}
                  placeholder="https://example.com/banner.jpg"
                  onSave={(v) => save(t.id, { bannerUrl: v.trim() || null })}
                  disabled={dis}
                />
                <ImageUploadButton
                  bucket="avatars"
                  onUploaded={(url) => save(t.id, { bannerUrl: url })}
                  onError={(err) => setErrors((e) => ({ ...e, [t.id]: err }))}
                  className="shrink-0 flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-text hover:bg-panel2 disabled:opacity-50"
                />
              </div>
              {t.bannerUrl && (
                <img src={t.bannerUrl} alt="" className="mt-2 h-20 w-full rounded-lg object-cover border border-border" />
              )}
              <p className="mt-1 text-xs text-muted">Wide banner shown in the topic info modal. JPEG, PNG, GIF, WebP · max 10 MB.</p>
            </div>

            {/* Permissions */}
            <div className="space-y-3 border-t border-border pt-3">
              <p className="text-xs text-muted">
                These roles are also synced as <code className="bg-panel2 px-1 rounded">topic.{t.slug}.*</code> permissions — assignable from the roles page.
              </p>
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Who can view</div>
                <RolesCheckboxes roles={t.viewRoles} allRoles={allRoles} onSave={(r) => save(t.id, { viewRoles: r })} disabled={dis} />
                <p className="mt-1 text-xs text-muted">
                  {t.viewRoles.length === 0 ? "Everyone can see this topic." : `Only ${t.viewRoles.join(", ")} can see this topic.`}
                </p>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Who can read</div>
                <RolesCheckboxes roles={t.readRoles} allRoles={allRoles} onSave={(r) => save(t.id, { readRoles: r })} disabled={dis} />
                <p className="mt-1 text-xs text-muted">
                  {t.readRoles.length === 0 ? "Everyone can read." : `Only ${t.readRoles.join(", ")} can read.`}
                </p>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Who can post</div>
                <RolesCheckboxes roles={t.postRoles} allRoles={allRoles} onSave={(r) => save(t.id, { postRoles: r })} disabled={dis} />
                <p className="mt-1 text-xs text-muted">
                  {t.postRoles.length === 0 ? "Everyone can post." : `Only ${t.postRoles.join(", ")} can post.`}
                </p>
              </div>
            </div>

            {/* P2P config */}
            {t.isP2p && (
              <div className="border-t border-border pt-3 space-y-3">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
                  <Radio className="h-3.5 w-3.5" /> P2P settings
                </div>
                <label className="flex cursor-pointer items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={t.p2pFallbackE2ee}
                    onChange={(e) => save(t.id, { p2pFallbackE2ee: e.target.checked })}
                    className="accent-accent"
                    disabled={dis || !t.isE2ee}
                  />
                  <span>
                    Fall back to server E2EE relay when over participant limit
                    {!t.isE2ee && <span className="ml-1 text-muted">(requires E2EE to be enabled)</span>}
                  </span>
                </label>
                <div className="flex items-center gap-3">
                  <label className="text-xs text-muted w-40">Max participants override</label>
                  <input
                    type="number"
                    min="2"
                    max="100"
                    value={t.p2pMaxParticipants ?? ""}
                    placeholder="Use global default"
                    onChange={(e) => {
                      const v = e.target.value === "" ? null : parseInt(e.target.value, 10);
                      save(t.id, { p2pMaxParticipants: v });
                    }}
                    disabled={dis}
                    className="w-36 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent"
                  />
                </div>
              </div>
            )}

            {/* Retention */}
            <div className="border-t border-border pt-3">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Retention policy</div>
              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={t.autoDeleteMode}
                  onChange={(e) => save(t.id, { autoDeleteMode: e.target.value as "none" | "age" | "count" })}
                  disabled={dis}
                  className="rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm"
                >
                  <option value="none">No limit</option>
                  <option value="age">By age</option>
                  <option value="count">By count</option>
                </select>

                {t.autoDeleteMode === "age" && (
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      value={draft.ageValue}
                      onChange={(e) =>
                        setRetentionDraft((d) => ({ ...d, [t.id]: { ...d[t.id]!, ageValue: e.target.value } }))
                      }
                      className="w-20 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm"
                    />
                    <select
                      value={draft.ageUnit}
                      onChange={(e) =>
                        setRetentionDraft((d) => ({
                          ...d,
                          [t.id]: { ...d[t.id]!, ageUnit: e.target.value as "hours" | "days" },
                        }))
                      }
                      className="rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm"
                    >
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                    </select>
                    <button
                      onClick={() => saveRetention(t.id)}
                      disabled={dis}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                )}

                {t.autoDeleteMode === "count" && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted">keep last</span>
                    <input
                      type="number"
                      min="1"
                      value={draft.maxMessages}
                      onChange={(e) =>
                        setRetentionDraft((d) => ({ ...d, [t.id]: { ...d[t.id]!, maxMessages: e.target.value } }))
                      }
                      className="w-24 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm"
                    />
                    <span className="text-sm text-muted">messages</span>
                    <button
                      onClick={() => saveRetention(t.id)}
                      disabled={dis}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                )}

                {t.autoDeleteMode !== "none" && (
                  <button
                    onClick={() => purge(t.id)}
                    disabled={purging === t.id || dis}
                    className="rounded-lg border border-danger px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger hover:text-white disabled:opacity-50"
                  >
                    {purging === t.id ? "Purging…" : "Apply now"}
                  </button>
                )}
              </div>
            </div>

            {errors[t.id] && <p className="text-xs text-danger">{errors[t.id]}</p>}
          </div>
        );
      })}
    </div>
  );
}

function InlineTextInput({ value, placeholder, onSave, disabled, mono }: { value: string; placeholder?: string; onSave: (v: string) => void; disabled?: boolean; mono?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <input
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onSave(draft); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
      disabled={disabled}
      className={`w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50${mono ? " font-mono" : ""}`}
    />
  );
}
