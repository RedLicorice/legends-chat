"use client";
import { apiFetch } from "@/lib/fetch";

import { useEffect, useState } from "react";
import { ChevronLeft, Plus, Trash2, Copy } from "lucide-react";
import { PERMISSIONS } from "@legends/shared";

interface RoleData {
  name: string;
  label: string;
  isSystem: boolean;
  sortOrder: number;
  permissions: string[];
}

const STATIC_PERMISSIONS = Object.values(PERMISSIONS).sort();

const PERMISSION_LABELS: Record<string, string> = {
  "admin.config": "Admin — configuration",
  "bots.manage": "Bots — manage",
  "content.attachment": "Content — attach files/images",
  "content.gif.upload": "Content — upload GIFs",
  "invites.create": "Invites — create",
  "invites.create.elevated": "Invites — create elevated",
  "messages.delete.any": "Messages — delete any",
  "messages.delete.own": "Messages — delete own",
  "messages.flag": "Messages — flag/report",
  "moderation.queue.review": "Moderation — review queue",
  "topics.create": "Topics — create",
  "topics.manage": "Topics — manage",
  "users.ban.direct": "Users — ban",
  "users.ban.lift": "Users — lift ban",
  "users.mute.direct": "Users — mute",
  "users.mute.lift": "Users — lift mute",
};

interface TopicPerm {
  slug: string;
  title: string;
  actions: ("view" | "read" | "post")[];
}

interface Props {
  roles: RoleData[];
}

const EMPTY_CREATE = { name: "", label: "", cloneFrom: "" };

export function AdminRolesForm({ roles: initial }: Props) {
  const [roles, setRoles] = useState(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [editPerms, setEditPerms] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(initial.map((r) => [r.name, r.permissions])),
  );
  const [editLabels, setEditLabels] = useState<Record<string, string>>(() =>
    Object.fromEntries(initial.map((r) => [r.name, r.label])),
  );
  const [saving, setSaving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [createForm, setCreateForm] = useState(EMPTY_CREATE);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [topicPerms, setTopicPerms] = useState<TopicPerm[]>([]);

  useEffect(() => {
    apiFetch("/api/admin/topics")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { topics: { slug: string; title: string }[] } | null) => {
        if (!data?.topics) return;
        setTopicPerms(data.topics.map((t) => ({ slug: t.slug, title: t.title, actions: ["view", "read", "post"] })));
      })
      .catch(() => {});
  }, []);

  async function saveRole(name: string) {
    setSaving(name);
    setErrors((e) => ({ ...e, [name]: "" }));
    setSaved((s) => ({ ...s, [name]: false }));
    try {
      const res = await apiFetch(`/api/admin/roles/${name}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: editLabels[name], permissions: editPerms[name] ?? [] }),
      });
      if (!res.ok) throw new Error("save failed");
      setRoles((prev) => prev.map((r) => r.name === name ? { ...r, label: editLabels[name] ?? r.label, permissions: editPerms[name] ?? r.permissions } : r));
      setSaved((s) => ({ ...s, [name]: true }));
    } catch {
      setErrors((e) => ({ ...e, [name]: "Save failed" }));
    } finally {
      setSaving(null);
    }
  }

  async function deleteRole(name: string, label: string) {
    if (!window.confirm(`Delete role "${label}"? Users with this role will still have it assigned but gain no permissions.`)) return;
    setDeleting(name);
    try {
      const res = await apiFetch(`/api/admin/roles/${name}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? "delete failed");
      }
      setRoles((prev) => prev.filter((r) => r.name !== name));
      setSelected(null);
    } catch (e) {
      setErrors((prev) => ({ ...prev, [name]: (e as Error).message }));
    } finally {
      setDeleting(null);
    }
  }

  async function createRole() {
    const name = createForm.name.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (!name || !createForm.label.trim()) { setCreateError("Name and label required"); return; }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiFetch("/api/admin/roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, label: createForm.label.trim(), cloneFrom: createForm.cloneFrom || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setCreateError(data.error ?? "Create failed"); return; }
      const newRole: RoleData = { name: data.role.name, label: data.role.label, isSystem: false, sortOrder: data.role.sortOrder, permissions: data.permissions };
      setRoles((prev) => [...prev, newRole]);
      setEditPerms((p) => ({ ...p, [newRole.name]: newRole.permissions }));
      setEditLabels((l) => ({ ...l, [newRole.name]: newRole.label }));
      setCreateForm(EMPTY_CREATE);
      setSelected(newRole.name);
    } catch {
      setCreateError("Create failed");
    } finally {
      setCreating(false);
    }
  }

  function togglePerm(roleName: string, perm: string) {
    setEditPerms((prev) => {
      const cur = prev[roleName] ?? [];
      return { ...prev, [roleName]: cur.includes(perm) ? cur.filter((p) => p !== perm) : [...cur, perm] };
    });
  }

  const role = roles.find((r) => r.name === selected) ?? null;
  const dis = role ? saving === role.name || deleting === role.name : false;

  return (
    <div className="flex overflow-hidden rounded-xl border border-border" style={{ height: "min(calc(100vh - 12rem), 800px)" }}>
      {/* Left: role list */}
      <div className={`flex-col border-r border-border bg-panel ${selected ? "hidden md:flex md:w-56 md:shrink-0" : "flex w-full md:w-56 md:shrink-0"}`}>
        <div className="flex items-center justify-between border-b border-border p-3">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Roles</span>
          <button
            type="button"
            onClick={() => { setSelected("__new__"); setCreateForm(EMPTY_CREATE); setCreateError(null); }}
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted hover:bg-panel2 hover:text-text"
          >
            <Plus className="h-3.5 w-3.5" /> New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {roles.length === 0 && <p className="p-4 text-xs text-muted">No roles yet.</p>}
          {roles.map((r) => (
            <button
              key={r.name}
              type="button"
              onClick={() => setSelected(r.name)}
              className={`w-full border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-panel2 ${selected === r.name ? "border-l-2 border-l-accent bg-panel2" : ""}`}
            >
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{r.label}</span>
                {r.isSystem && <span className="shrink-0 rounded-full bg-accent/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">sys</span>}
              </div>
              <div className="truncate font-mono text-xs text-muted">{r.name}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Right: detail */}
      <div className={`flex-1 overflow-y-auto bg-panel ${selected ? "flex" : "hidden md:flex"} flex-col`}>
        {selected === "__new__" ? (
          <div className="space-y-4 p-6">
            <div className="flex items-center gap-2">
              <button type="button" className="flex items-center gap-1 text-sm text-muted md:hidden" onClick={() => setSelected(null)}>
                <ChevronLeft className="h-4 w-4" />
              </button>
              <h2 className="text-sm font-semibold">New role</h2>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Name</label>
                <input
                  value={createForm.name}
                  onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") }))}
                  placeholder="premium"
                  className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm font-mono outline-none focus:border-accent"
                />
                <p className="mt-1 text-xs text-muted">Lowercase letters, numbers, underscores.</p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Label</label>
                <input
                  value={createForm.label}
                  onChange={(e) => setCreateForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="Premium"
                  className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Copy permissions from</label>
              <select
                value={createForm.cloneFrom}
                onChange={(e) => setCreateForm((f) => ({ ...f, cloneFrom: e.target.value }))}
                className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent sm:w-64"
              >
                <option value="">— start empty —</option>
                {roles.map((r) => <option key={r.name} value={r.name}>{r.label} ({r.name})</option>)}
              </select>
            </div>
            {createError && <p className="text-xs text-danger">{createError}</p>}
            <div className="flex gap-2">
              <button
                onClick={createRole}
                disabled={creating || !createForm.name || !createForm.label}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create role"}
              </button>
              <button
                onClick={() => { setSelected(null); setCreateForm(EMPTY_CREATE); setCreateError(null); }}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-panel2"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : role ? (
          <div key={role.name} className="space-y-4 p-6">
            {/* Mobile back */}
            <button type="button" className="flex items-center gap-1 text-sm text-muted md:hidden" onClick={() => setSelected(null)}>
              <ChevronLeft className="h-4 w-4" /> Back
            </button>

            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-panel2 px-2 py-0.5 font-mono text-xs text-muted">{role.name}</code>
                  {role.isSystem && (
                    <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">system</span>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Display name</label>
                  <input
                    value={editLabels[role.name] ?? role.label}
                    onChange={(e) => setEditLabels((l) => ({ ...l, [role.name]: e.target.value }))}
                    disabled={dis}
                    className="rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent"
                  />
                </div>
              </div>
              {!role.isSystem && (
                <button
                  onClick={() => deleteRole(role.name, role.label)}
                  disabled={dis}
                  className="mt-1 flex items-center gap-1 rounded-lg border border-danger px-2 py-1.5 text-xs text-danger hover:bg-danger hover:text-white disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {deleting === role.name ? "Deleting…" : "Delete"}
                </button>
              )}
            </div>

            {/* Static permissions */}
            <div className="border-t border-border pt-3">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Permissions</div>
              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {STATIC_PERMISSIONS.map((perm) => (
                  <label key={perm} className="flex cursor-pointer items-center gap-2 text-sm">
                    <span className="flex h-11 w-11 items-center justify-center">
                      <input type="checkbox" className="accent-accent" checked={(editPerms[role.name] ?? []).includes(perm)} disabled={dis} onChange={() => togglePerm(role.name, perm)} />
                    </span>
                    <span className="min-w-0 truncate" title={perm}>{PERMISSION_LABELS[perm] ?? perm}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Topic permissions */}
            {topicPerms.length > 0 && (
              <div className="border-t border-border pt-3">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Topic access</div>
                <div className="space-y-2">
                  {topicPerms.map((tp) => (
                    <div key={tp.slug} className="rounded-lg border border-border bg-panel2 p-3">
                      <div className="mb-1.5 text-xs font-medium">
                        {tp.title} <span className="font-mono text-muted">#{tp.slug}</span>
                      </div>
                      <div className="flex flex-wrap gap-4">
                        {tp.actions.map((action) => {
                          const perm = `topic.${tp.slug}.${action}`;
                          return (
                            <label key={action} className="flex cursor-pointer items-center gap-1.5 text-sm capitalize">
                              <span className="flex h-11 w-11 items-center justify-center">
                                <input type="checkbox" className="accent-accent" checked={(editPerms[role.name] ?? []).includes(perm)} disabled={dis} onChange={() => togglePerm(role.name, perm)} />
                              </span>
                              {action}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted">Unchecked = unrestricted (everyone). Check to restrict that action to this role.</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-3 border-t border-border pt-3">
              <button
                onClick={() => saveRole(role.name)}
                disabled={dis}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving === role.name ? "Saving…" : "Save"}
              </button>
              <button
                onClick={() => {
                  setCreateForm({ name: role.name + "_copy", label: role.label + " (copy)", cloneFrom: role.name });
                  setSelected("__new__");
                }}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-panel2 hover:text-text"
              >
                <Copy className="h-3.5 w-3.5" /> Clone
              </button>
              {errors[role.name] && <p className="text-xs text-danger">{errors[role.name]}</p>}
              {saved[role.name] && <p className="text-xs text-green-400">Saved.</p>}
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-sm text-muted">
            Select a role to edit, or create a new one.
          </div>
        )}
      </div>
    </div>
  );
}
