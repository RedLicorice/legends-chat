"use client";
import { apiFetch } from "@/lib/fetch";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Plus, Trash2, Radio } from "lucide-react";
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
  replyRoles: string[];
  autoDeleteMode: "none" | "age" | "count";
  autoDeleteAgeSeconds: number | null;
  autoDeleteMaxMessages: number | null;
  passwordProtected: boolean;
  passwordVersion: number;
  passwordReentryDays: number;
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

interface Grant {
  topicId: string;
  principalType: string;
  principalId: string;
  principalName: string;
  action: string;
  effect: string;
  expiresAt: string | null;
}

type RetentionDraft = Record<string, { ageValue: string; ageUnit: "hours" | "days"; maxMessages: string }>;
const EMPTY_CREATE = { slug: "", title: "", description: "" };

export function AdminTopicsForm({ topics: initial, initialSelected }: { topics: TopicRow[]; initialSelected?: string }) {
  const [topics, setTopics] = useState(initial);
  const [selected, setSelected] = useState<string | null>(initialSelected ?? null);
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
  const [pwDraft, setPwDraft] = useState<Record<string, {
    newPassword: string;
    reentryDays: string;
    requireImmediate: boolean;
    saving: boolean;
    error: string | null;
  }>>(() =>
    Object.fromEntries(
      initial.map((t) => [
        t.id,
        { newPassword: "", reentryDays: String(t.passwordReentryDays), requireImmediate: false, saving: false, error: null },
      ]),
    ),
  );
  const [createForm, setCreateForm] = useState(EMPTY_CREATE);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(false);
  // Bulk-selection state — Set<topicId>. Stays unchanged across sort/filter
  // changes; if a topic scrolls out of view it remains selected but the row
  // checkbox is just not rendered (fine for v1).
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(() => new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const router = useRouter();

  const allSelected = topics.length > 0 && bulkSelected.size === topics.length;
  const someSelected = bulkSelected.size > 0 && !allSelected;
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  function toggleSelected(id: string, checked: boolean) {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleSelectAll(checked: boolean) {
    setBulkSelected(checked ? new Set(topics.map((t) => t.id)) : new Set());
  }

  function clearBulkSelection() {
    setBulkSelected(new Set());
    setBulkError(null);
  }

  async function bulkDelete() {
    const ids = Array.from(bulkSelected);
    if (ids.length === 0) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      // Server caps each bulk call at 200 ids. Chunk client-side so users can
      // mass-delete arbitrarily large selections without seeing 400s.
      const CHUNK = 200;
      const deletedAll = new Set<string>();
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const res = await apiFetch("/api/admin/topics/bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "delete", ids: chunk }),
        });
        if (!res.ok) {
          const detail = await res.json().catch(() => null);
          console.error("[admin-topics] bulk delete failed", res.status, detail);
          throw new Error(
            `bulk delete failed (${res.status}: ${detail?.error ?? "unknown"})`,
          );
        }
        const data = (await res.json()) as { ok: boolean; deleted: number; ids: string[] };
        for (const id of data.ids) deletedAll.add(id);
      }
      setTopics((prev) => prev.filter((t) => !deletedAll.has(t.id)));
      if (selected && deletedAll.has(selected)) setSelected(null);
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

  useEffect(() => {
    apiFetch("/api/admin/roles")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { name: string }[] | null) => {
        if (!data) return;
        setAllRoles(data.map((r) => r.name));
      })
      .catch(() => {});
  }, []);

  const fetchGrants = useCallback(async (topicId: string) => {
    setGrantsLoading(true);
    try {
      const res = await fetch(`/api/admin/topics/${topicId}/grants`);
      const data = await res.json() as { grants: Grant[] };
      setGrants(data.grants ?? []);
    } finally {
      setGrantsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selected && selected !== "__new__") {
      void fetchGrants(selected);
    } else {
      setGrants([]);
    }
  }, [selected, fetchGrants]);

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
      if (isNaN(v) || v <= 0) { setErrors((e) => ({ ...e, [id]: "Invalid age value" })); return; }
      patch.autoDeleteAgeSeconds = Math.round(v * (draft.ageUnit === "days" ? 86400 : 3600));
    } else if (t.autoDeleteMode === "count") {
      const v = parseInt(draft.maxMessages, 10);
      if (isNaN(v) || v <= 0) { setErrors((e) => ({ ...e, [id]: "Invalid count value" })); return; }
      patch.autoDeleteMaxMessages = v;
    }
    if (Object.keys(patch).length > 0) await save(id, patch);
  }

  async function savePassword(id: string) {
    const pw = pwDraft[id]!;
    setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, saving: true, error: null } }));
    try {
      const body: Record<string, unknown> = {
        passwordReentryDays: parseInt(pw.reentryDays, 10) || 7,
      };
      if (pw.newPassword.trim()) {
        body.newPassword = pw.newPassword.trim();
        body.requireImmediateReentry = pw.requireImmediate;
      }
      const res = await apiFetch(`/api/admin/topics/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("save failed");
      const data = await res.json() as { topic: TopicRow };
      setTopics((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                passwordProtected: data.topic.passwordProtected,
                passwordVersion: data.topic.passwordVersion,
                passwordReentryDays: data.topic.passwordReentryDays,
              }
            : t,
        ),
      );
      setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, newPassword: "", requireImmediate: false, error: null } }));
      router.refresh();
    } catch {
      setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, error: "Save failed" } }));
    } finally {
      setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, saving: false } }));
    }
  }

  async function clearPassword(id: string) {
    setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, saving: true, error: null } }));
    try {
      const res = await apiFetch(`/api/admin/topics/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword: null }),
      });
      if (!res.ok) throw new Error("clear failed");
      setTopics((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, passwordProtected: false, passwordVersion: 0 } : t,
        ),
      );
      setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, newPassword: "", requireImmediate: false, error: null } }));
      router.refresh();
    } catch {
      setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, error: "Clear failed" } }));
    } finally {
      setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, saving: false } }));
    }
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
      setSelected(null);
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
      if (!res.ok) { setCreateError(data.error?.formErrors?.[0] ?? "Create failed"); return; }
      const t = data.topic;
      const newTopic: TopicRow = {
        id: t.id, slug: t.slug, title: t.title, description: t.description,
        iconUrl: t.iconUrl ?? null, bannerUrl: t.bannerUrl ?? null,
        isSticky: t.isSticky, sortOrder: t.sortOrder,
        isFeed: t.isFeed, isHomeTopic: t.isHomeTopic, isE2ee: t.isE2ee,
        isP2p: t.isP2p ?? false, p2pFallbackE2ee: t.p2pFallbackE2ee ?? false,
        p2pMaxParticipants: t.p2pMaxParticipants ?? null,
        viewRoles: (t.viewRoles as string[] | null) ?? [],
        postRoles: (t.postRoles as string[] | null) ?? [],
        readRoles: (t.readRoles as string[] | null) ?? [],
        replyRoles: (t.replyRoles as string[] | null) ?? [],
        autoDeleteMode: t.autoDeleteMode,
        autoDeleteAgeSeconds: t.autoDeleteAgeSeconds,
        autoDeleteMaxMessages: t.autoDeleteMaxMessages,
        passwordProtected: false,
        passwordVersion: 0,
        passwordReentryDays: 7,
      };
      setTopics((prev) => [...prev, newTopic]);
      setRetentionDraft((d) => ({ ...d, [t.id]: { ageValue: "24", ageUnit: "hours", maxMessages: "1000" } }));
      setPwDraft((d) => ({ ...d, [t.id]: { newPassword: "", reentryDays: "7", requireImmediate: false, saving: false, error: null } }));
      setCreateForm(EMPTY_CREATE);
      setSelected(t.id);
      router.refresh();
    } catch {
      setCreateError("Create failed");
    } finally {
      setCreating(false);
    }
  }

  const topic = topics.find((t) => t.id === selected) ?? null;
  const dis = topic ? saving === topic.id || deleting === topic.id : false;
  const draft = topic ? retentionDraft[topic.id]! : null;

  return (
    <div className="flex overflow-hidden rounded-xl border border-border" style={{ height: "min(calc(100vh - 12rem), 800px)" }}>
      {/* Left: topic list */}
      <div className={`flex-col border-r border-border bg-panel ${selected ? "hidden md:flex md:w-56 md:shrink-0" : "flex w-full md:w-56 md:shrink-0"}`}>
        <div className="flex items-center justify-between border-b border-border p-3">
          <div className="flex items-center gap-2">
            <input
              ref={selectAllRef}
              type="checkbox"
              className="accent-accent"
              aria-label="Select all topics"
              checked={allSelected}
              onChange={(e) => toggleSelectAll(e.target.checked)}
              disabled={topics.length === 0}
            />
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Topics</span>
          </div>
          <button
            type="button"
            onClick={() => { setSelected("__new__"); setCreateForm(EMPTY_CREATE); setCreateError(null); }}
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted hover:bg-panel2 hover:text-text"
          >
            <Plus className="h-3.5 w-3.5" /> New
          </button>
        </div>

        {/* Bulk action bar — sticky above the scrolling list */}
        {bulkSelected.size > 0 && (
          <div className="sticky top-0 z-10 flex flex-col gap-1.5 border-b border-border bg-panel2 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-text">{bulkSelected.size} selected</span>
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
          {topics.length === 0 && <p className="p-4 text-xs text-muted">No topics yet.</p>}
          {topics.map((t) => (
            <div
              key={t.id}
              className={`flex items-start gap-2 border-b border-border px-3 py-2.5 transition-colors hover:bg-panel2 ${selected === t.id ? "border-l-2 border-l-accent bg-panel2" : ""}`}
            >
              <input
                type="checkbox"
                className="mt-1 shrink-0 accent-accent"
                aria-label={`Select topic ${t.title}`}
                checked={bulkSelected.has(t.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => toggleSelected(t.id, e.target.checked)}
              />
              <button
                type="button"
                onClick={() => setSelected(t.id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="truncate text-sm font-medium">{t.title}</div>
                <div className="truncate font-mono text-xs text-muted">#{t.slug}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {t.isFeed && <span className="rounded bg-accent/10 px-1 text-[10px] text-accent">Feed</span>}
                  {t.isHomeTopic && <span className="rounded bg-accent/10 px-1 text-[10px] text-accent">Home</span>}
                  {t.isSticky && <span className="rounded border border-border bg-panel2 px-1 text-[10px] text-muted">Sticky</span>}
                  {t.isE2ee && <span className="rounded bg-green-500/10 px-1 text-[10px] text-green-400">E2EE</span>}
                  {t.isP2p && <span className="rounded bg-blue-500/10 px-1 text-[10px] text-blue-400">P2P</span>}
                </div>
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Bulk delete confirmation modal */}
      {bulkConfirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm bulk delete topics"
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-panel p-5 shadow-xl">
            <h5 className="mb-2 text-sm font-semibold">Delete {bulkSelected.size} topics?</h5>
            <p className="mb-4 text-xs text-muted">
              Delete {bulkSelected.size} topic{bulkSelected.size === 1 ? "" : "s"} and all their messages? This cannot be undone.
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

      {/* Right: detail */}
      <div className={`flex-1 overflow-y-auto bg-panel ${selected ? "flex" : "hidden md:flex"} flex-col`}>
        {selected === "__new__" ? (
          <div className="space-y-4 p-6">
            <div className="flex items-center gap-2">
              <button type="button" className="flex items-center gap-1 text-sm text-muted md:hidden" onClick={() => setSelected(null)}>
                <ChevronLeft className="h-4 w-4" />
              </button>
              <h2 className="text-sm font-semibold">New topic</h2>
            </div>
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
                  className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm font-mono outline-none focus:border-accent"
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
                onClick={() => { setSelected(null); setCreateForm(EMPTY_CREATE); setCreateError(null); }}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-panel2"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : topic && draft ? (
          <div key={topic.id} className="space-y-4 p-6">
            {/* Mobile back */}
            <button type="button" className="flex items-center gap-1 text-sm text-muted md:hidden" onClick={() => setSelected(null)}>
              <ChevronLeft className="h-4 w-4" /> Back
            </button>

            {/* Header */}
            <div>
              <div className="mb-3 grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Title</label>
                  <InlineTextInput value={topic.title} placeholder="General" onSave={(v) => save(topic.id, { title: v.trim() || topic.title })} disabled={dis} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Slug</label>
                  <InlineTextInput value={topic.slug} placeholder="general" onSave={(v) => save(topic.id, { slug: v.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-") || topic.slug })} disabled={dis} mono />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                {(["isFeed", "isHomeTopic", "isSticky"] as const).map((key) => (
                  <label key={key} className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={topic[key] as boolean} onChange={(e) => save(topic.id, { [key]: e.target.checked })} className="accent-accent" disabled={dis} />
                    {{ isFeed: "Feed", isHomeTopic: "Home", isSticky: "Sticky" }[key]}
                  </label>
                ))}
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={topic.isE2ee} onChange={(e) => toggleE2ee(topic.id, e.target.checked)} className="accent-accent" disabled={dis} />
                  E2EE
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={topic.isP2p} onChange={(e) => save(topic.id, { isP2p: e.target.checked })} className="accent-accent" disabled={dis} />
                  <Radio className="h-3.5 w-3.5" /> P2P
                </label>
                <button
                  onClick={() => deleteTopic(topic.id, topic.title)}
                  disabled={dis}
                  className="ml-auto flex items-center gap-1 rounded-lg border border-danger px-2 py-1 text-xs text-danger hover:bg-danger hover:text-white disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {deleting === topic.id ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>

            {/* Icon */}
            <div className="border-t border-border pt-3">
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Icon</label>
              <div className="flex items-start gap-2">
                {topic.iconUrl && <img src={topic.iconUrl} alt="" className="h-9 w-9 shrink-0 rounded border border-border bg-panel2 object-cover" />}
                <InlineTextInput value={topic.iconUrl ?? ""} placeholder="https://example.com/icon.png" onSave={(v) => save(topic.id, { iconUrl: v.trim() || null })} disabled={dis} />
                <ImageUploadButton bucket="avatars" onUploaded={(url) => save(topic.id, { iconUrl: url })} onError={(err) => setErrors((e) => ({ ...e, [topic.id]: err }))} className="shrink-0 flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-panel2 hover:text-text disabled:opacity-50" />
              </div>
              <p className="mt-1 text-xs text-muted">Square image shown as topic icon in the sidebar. Leave blank to use initials. JPEG, PNG, GIF, WebP · max 10 MB.</p>
            </div>

            {/* Banner */}
            <div className="border-t border-border pt-3">
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Banner</label>
              <div className="flex items-start gap-2">
                <InlineTextInput value={topic.bannerUrl ?? ""} placeholder="https://example.com/banner.jpg" onSave={(v) => save(topic.id, { bannerUrl: v.trim() || null })} disabled={dis} />
                <ImageUploadButton bucket="avatars" onUploaded={(url) => save(topic.id, { bannerUrl: url })} onError={(err) => setErrors((e) => ({ ...e, [topic.id]: err }))} className="shrink-0 flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-panel2 hover:text-text disabled:opacity-50" />
              </div>
              {topic.bannerUrl && <img src={topic.bannerUrl} alt="" className="mt-2 h-20 w-full rounded-lg border border-border object-cover" />}
              <p className="mt-1 text-xs text-muted">Wide banner shown in the topic info modal. JPEG, PNG, GIF, WebP · max 10 MB.</p>
            </div>

            {/* Permissions */}
            <div className="space-y-3 border-t border-border pt-3">
              <p className="text-xs text-muted">
                These roles are also synced as <code className="rounded bg-panel2 px-1">topic.{topic.slug}.*</code> permissions — assignable from the roles page.
              </p>
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Who can view</div>
                <RolesCheckboxes roles={topic.viewRoles} allRoles={allRoles} onSave={(r) => save(topic.id, { viewRoles: r })} disabled={dis} />
                <p className="mt-1 text-xs text-muted">{topic.viewRoles.length === 0 ? "Everyone can see this topic." : `Only ${topic.viewRoles.join(", ")} can see this topic.`}</p>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Who can read</div>
                <RolesCheckboxes roles={topic.readRoles} allRoles={allRoles} onSave={(r) => save(topic.id, { readRoles: r })} disabled={dis} />
                <p className="mt-1 text-xs text-muted">{topic.readRoles.length === 0 ? "Everyone can read." : `Only ${topic.readRoles.join(", ")} can read.`}</p>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Who can post</div>
                <RolesCheckboxes roles={topic.postRoles} allRoles={allRoles} onSave={(r) => save(topic.id, { postRoles: r })} disabled={dis} />
                <p className="mt-1 text-xs text-muted">{topic.postRoles.length === 0 ? "Everyone can post." : `Only ${topic.postRoles.join(", ")} can post.`}</p>
              </div>
              {topic.isFeed && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted">Who can comment?</label>
                  <RolesCheckboxes roles={topic.replyRoles} allRoles={allRoles} onSave={(r) => save(topic.id, { replyRoles: r })} disabled={dis} />
                  <p className="mt-1 text-xs text-muted">
                    {topic.replyRoles.length === 0
                      ? "Everyone who can read may comment."
                      : `Only ${topic.replyRoles.join(", ")} may comment.`}
                  </p>
                </div>
              )}
            </div>

            {/* P2P config */}
            {topic.isP2p && (
              <div className="space-y-3 border-t border-border pt-3">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
                  <Radio className="h-3.5 w-3.5" /> P2P settings
                </div>
                <label className="flex cursor-pointer items-center gap-3 text-sm">
                  <input type="checkbox" checked={topic.p2pFallbackE2ee} onChange={(e) => save(topic.id, { p2pFallbackE2ee: e.target.checked })} className="accent-accent" disabled={dis || !topic.isE2ee} />
                  <span>
                    Fall back to server E2EE relay when over participant limit
                    {!topic.isE2ee && <span className="ml-1 text-muted">(requires E2EE to be enabled)</span>}
                  </span>
                </label>
                <div className="flex items-center gap-3">
                  <label className="w-40 text-xs text-muted">Max participants override</label>
                  <input
                    type="number" min="2" max="100"
                    value={topic.p2pMaxParticipants ?? ""}
                    placeholder="Use global default"
                    onChange={(e) => {
                      const v = e.target.value === "" ? null : parseInt(e.target.value, 10);
                      save(topic.id, { p2pMaxParticipants: v });
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
                <select value={topic.autoDeleteMode} onChange={(e) => save(topic.id, { autoDeleteMode: e.target.value as "none" | "age" | "count" })} disabled={dis} className="rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm">
                  <option value="none">No limit</option>
                  <option value="age">By age</option>
                  <option value="count">By count</option>
                </select>
                {topic.autoDeleteMode === "age" && (
                  <div className="flex items-center gap-2">
                    <input type="number" min="1" value={draft.ageValue} onChange={(e) => setRetentionDraft((d) => ({ ...d, [topic.id]: { ...d[topic.id]!, ageValue: e.target.value } }))} className="w-20 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm" />
                    <select value={draft.ageUnit} onChange={(e) => setRetentionDraft((d) => ({ ...d, [topic.id]: { ...d[topic.id]!, ageUnit: e.target.value as "hours" | "days" } }))} className="rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm">
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                    </select>
                    <button onClick={() => saveRetention(topic.id)} disabled={dis} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Save</button>
                  </div>
                )}
                {topic.autoDeleteMode === "count" && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted">keep last</span>
                    <input type="number" min="1" value={draft.maxMessages} onChange={(e) => setRetentionDraft((d) => ({ ...d, [topic.id]: { ...d[topic.id]!, maxMessages: e.target.value } }))} className="w-24 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm" />
                    <span className="text-sm text-muted">messages</span>
                    <button onClick={() => saveRetention(topic.id)} disabled={dis} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Save</button>
                  </div>
                )}
                {topic.autoDeleteMode !== "none" && (
                  <button onClick={() => purge(topic.id)} disabled={purging === topic.id || dis} className="rounded-lg border border-danger px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger hover:text-white disabled:opacity-50">
                    {purging === topic.id ? "Purging…" : "Apply now"}
                  </button>
                )}
              </div>
            </div>

            {/* Password gate */}
            <div className="space-y-3 border-t border-border pt-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium uppercase tracking-wide text-muted">Password gate</div>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${topic.passwordProtected ? "bg-accent/10 text-accent" : "bg-panel2 text-muted"}`}>
                  {topic.passwordProtected ? "Protected" : "No password"}
                </span>
              </div>
              {pwDraft[topic.id] && (
                <div className="space-y-2">
                  <div>
                    <label className="mb-1 block text-xs text-muted">New password</label>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        placeholder={topic.passwordProtected ? "Leave blank to keep current" : "Set a password…"}
                        value={pwDraft[topic.id]!.newPassword}
                        onChange={(e) => setPwDraft((d) => ({ ...d, [topic.id]: { ...d[topic.id]!, newPassword: e.target.value } }))}
                        disabled={dis || pwDraft[topic.id]!.saving}
                        className="flex-1 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-50"
                      />
                      {topic.passwordProtected && (
                        <button
                          onClick={() => clearPassword(topic.id)}
                          disabled={dis || pwDraft[topic.id]!.saving}
                          className="rounded-lg border border-danger px-2 py-1.5 text-xs font-medium text-danger hover:bg-danger hover:text-white disabled:opacity-50"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-xs text-muted">Re-entry interval</label>
                    <input
                      type="number"
                      min="1"
                      max="365"
                      value={pwDraft[topic.id]!.reentryDays}
                      onChange={(e) => setPwDraft((d) => ({ ...d, [topic.id]: { ...d[topic.id]!, reentryDays: e.target.value } }))}
                      disabled={dis || pwDraft[topic.id]!.saving}
                      className="w-20 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-50"
                    />
                    <span className="text-xs text-muted">days</span>
                  </div>
                  {(topic.passwordProtected || pwDraft[topic.id]!.newPassword.trim()) && (
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="accent-accent"
                        checked={pwDraft[topic.id]!.requireImmediate}
                        disabled={dis || pwDraft[topic.id]!.saving}
                        onChange={(e) => setPwDraft((d) => ({ ...d, [topic.id]: { ...d[topic.id]!, requireImmediate: e.target.checked } }))}
                      />
                      Require immediate re-entry (invalidates all cached entries)
                    </label>
                  )}
                  {pwDraft[topic.id]!.error && <p className="text-xs text-danger">{pwDraft[topic.id]!.error}</p>}
                  <button
                    onClick={() => savePassword(topic.id)}
                    disabled={dis || pwDraft[topic.id]!.saving}
                    className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    {pwDraft[topic.id]!.saving ? "Saving…" : "Save password settings"}
                  </button>
                </div>
              )}
            </div>

            {/* Per-Principal Access Grants */}
            <div className="mt-6 border-t border-border pt-3">
              <h3 className="mb-3 text-sm font-semibold">Per-Principal Access Grants</h3>

              {grantsLoading ? (
                <p className="text-xs text-muted">Loading…</p>
              ) : grants.length === 0 ? (
                <p className="text-xs text-muted">No per-principal grants.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted">
                      <th className="pb-1 pr-2">Principal</th>
                      <th className="pb-1 pr-2">Type</th>
                      <th className="pb-1 pr-2">Action</th>
                      <th className="pb-1 pr-2">Effect</th>
                      <th className="pb-1 pr-2">Expires</th>
                      <th className="pb-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {grants.map((g) => (
                      <tr key={`${g.principalId}-${g.action}`} className={g.expiresAt && new Date(g.expiresAt) < new Date() ? "opacity-40" : ""}>
                        <td className="pr-2 py-0.5">{g.principalName}</td>
                        <td className="pr-2 py-0.5">{g.principalType}</td>
                        <td className="pr-2 py-0.5">{g.action}</td>
                        <td className={`pr-2 py-0.5 font-medium ${g.effect === "allow" ? "text-green-500" : "text-red-500"}`}>{g.effect}</td>
                        <td className="pr-2 py-0.5">{g.expiresAt ? new Date(g.expiresAt).toLocaleDateString() : "—"}</td>
                        <td className="py-0.5">
                          <button
                            type="button"
                            className="text-muted hover:text-red-500 transition"
                            onClick={async () => {
                              await fetch(`/api/admin/topics/${topic.id}/grants`, {
                                method: "DELETE",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ principalType: g.principalType, principalId: g.principalId, action: g.action }),
                              });
                              await fetchGrants(topic.id);
                            }}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <AddGrantForm topicId={topic.id} onAdded={() => fetchGrants(topic.id)} />
            </div>

            {errors[topic.id] && <p className="text-xs text-danger">{errors[topic.id]}</p>}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-sm text-muted">
            Select a topic to edit, or create a new one.
          </div>
        )}
      </div>
    </div>
  );
}

function AddGrantForm({ topicId, onAdded }: { topicId: string; onAdded: () => void }) {
  const [principalType, setPrincipalType] = useState<"user" | "bot">("user");
  const [principalId, setPrincipalId] = useState("");
  const [principalName, setPrincipalName] = useState("");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<{ id: string; label: string }[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [action, setAction] = useState("post");
  const [effect, setEffect] = useState("allow");
  const [expiresAt, setExpiresAt] = useState("");
  const [saving, setSaving] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowResults(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const doSearch = useCallback(async (q: string, type: "user" | "bot") => {
    if (!q.trim()) { setResults([]); return; }
    if (type === "user") {
      const res = await fetch(`/api/admin/users?q=${encodeURIComponent(q)}`);
      if (!res.ok) return;
      const data = await res.json() as { id: string; displayName: string }[];
      setResults(data.slice(0, 8).map((u) => ({ id: u.id, label: u.displayName })));
    } else {
      const res = await fetch("/api/admin/bots");
      if (!res.ok) return;
      const data = await res.json() as { id: string; name: string }[];
      const filtered = data.filter((b) => b.name.toLowerCase().includes(q.toLowerCase()));
      setResults(filtered.slice(0, 8).map((b) => ({ id: b.id, label: b.name })));
    }
    setShowResults(true);
  }, []);

  useEffect(() => {
    if (!search.trim()) { setResults([]); setShowResults(false); return; }
    const t = setTimeout(() => void doSearch(search, principalType), 250);
    return () => clearTimeout(t);
  }, [search, principalType, doSearch]);

  function selectResult(r: { id: string; label: string }) {
    setPrincipalId(r.id);
    setPrincipalName(r.label);
    setSearch(r.label);
    setShowResults(false);
  }

  function handleTypeChange(t: "user" | "bot") {
    setPrincipalType(t);
    setPrincipalId("");
    setPrincipalName("");
    setSearch("");
    setResults([]);
  }

  async function submit() {
    if (!principalId.trim()) return;
    setSaving(true);
    try {
      await fetch(`/api/admin/topics/${topicId}/grants`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ principalType, principalId: principalId.trim(), action, effect, expiresAt: expiresAt || null }),
      });
      onAdded();
      setPrincipalId("");
      setPrincipalName("");
      setSearch("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <select className="rounded border border-border bg-panel px-2 py-1 text-xs" value={principalType} onChange={(e) => handleTypeChange(e.target.value as "user" | "bot")}>
        <option value="user">User</option>
        <option value="bot">Bot</option>
      </select>
      <div ref={searchRef} className="relative">
        <input
          className="rounded border border-border bg-panel px-2 py-1 text-xs w-48"
          placeholder={`Search ${principalType} by name…`}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPrincipalId(""); setPrincipalName(""); }}
          onFocus={() => { if (results.length > 0) setShowResults(true); }}
        />
        {principalId && <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-accent">✓</span>}
        {showResults && results.length > 0 && (
          <div className="absolute left-0 top-full z-50 mt-0.5 w-56 rounded border border-border bg-panel shadow-lg">
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                onMouseDown={() => selectResult(r)}
                className="flex w-full flex-col px-2 py-1.5 text-left hover:bg-panel2"
              >
                <span className="text-xs font-medium">{r.label}</span>
                <span className="font-mono text-[9px] text-muted">{r.id}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <select className="rounded border border-border bg-panel px-2 py-1 text-xs" value={action} onChange={(e) => setAction(e.target.value)}>
        <option value="view">view</option>
        <option value="read">read</option>
        <option value="post">post</option>
        <option value="reply">reply</option>
      </select>
      <select className="rounded border border-border bg-panel px-2 py-1 text-xs" value={effect} onChange={(e) => setEffect(e.target.value)}>
        <option value="allow">allow</option>
        <option value="deny">deny</option>
      </select>
      <input type="datetime-local" className="rounded border border-border bg-panel px-2 py-1 text-xs" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
      <button type="button" onClick={submit} disabled={saving || !principalId} className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50">
        {saving ? "…" : "Add Grant"}
      </button>
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
