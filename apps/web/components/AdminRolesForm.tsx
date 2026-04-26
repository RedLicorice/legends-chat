"use client";

import { useState } from "react";
import { Plus, Trash2, Copy } from "lucide-react";
import { PERMISSIONS } from "@legends/shared";

interface RoleData {
  name: string;
  label: string;
  isSystem: boolean;
  sortOrder: number;
  permissions: string[];
}

const ALL_PERMISSIONS = Object.values(PERMISSIONS).sort();

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

interface Props {
  roles: RoleData[];
}

export function AdminRolesForm({ roles: initial }: Props) {
  const [roles, setRoles] = useState(initial);
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
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createLabel, setCreateLabel] = useState("");
  const [cloneFrom, setCloneFrom] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function saveRole(name: string) {
    setSaving(name);
    setErrors((e) => ({ ...e, [name]: "" }));
    setSaved((s) => ({ ...s, [name]: false }));
    try {
      const res = await fetch(`/api/admin/roles/${name}`, {
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
      const res = await fetch(`/api/admin/roles/${name}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? "delete failed");
      }
      setRoles((prev) => prev.filter((r) => r.name !== name));
    } catch (e) {
      setErrors((prev) => ({ ...prev, [name]: (e as Error).message }));
    } finally {
      setDeleting(null);
    }
  }

  async function createRole() {
    const name = createName.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (!name || !createLabel.trim()) { setCreateError("Name and label required"); return; }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/admin/roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, label: createLabel.trim(), cloneFrom: cloneFrom || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setCreateError(data.error ?? "Create failed"); return; }
      const newRole: RoleData = { name: data.role.name, label: data.role.label, isSystem: false, sortOrder: data.role.sortOrder, permissions: data.permissions };
      setRoles((prev) => [...prev, newRole]);
      setEditPerms((p) => ({ ...p, [newRole.name]: newRole.permissions }));
      setEditLabels((l) => ({ ...l, [newRole.name]: newRole.label }));
      setCreateName("");
      setCreateLabel("");
      setCloneFrom("");
      setShowCreate(false);
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

  return (
    <div className="space-y-4">
      {/* Create form */}
      {showCreate ? (
        <div className="rounded-xl border border-accent bg-panel p-5 space-y-3">
          <h2 className="text-sm font-semibold">New role</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Name</label>
              <input
                value={createName}
                onChange={(e) => setCreateName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
                placeholder="premium"
                className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm font-mono outline-none focus:border-accent"
              />
              <p className="mt-1 text-xs text-muted">Lowercase letters, numbers, underscores.</p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Label</label>
              <input
                value={createLabel}
                onChange={(e) => setCreateLabel(e.target.value)}
                placeholder="Premium"
                className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Copy permissions from</label>
            <select
              value={cloneFrom}
              onChange={(e) => setCloneFrom(e.target.value)}
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
              disabled={creating || !createName || !createLabel}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create role"}
            </button>
            <button
              onClick={() => { setShowCreate(false); setCreateName(""); setCreateLabel(""); setCloneFrom(""); setCreateError(null); }}
              className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-panel2"
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
          <Plus className="h-4 w-4" /> New role
        </button>
      )}

      {/* Role list */}
      {roles.map((role) => {
        const perms = editPerms[role.name] ?? [];
        const dis = saving === role.name || deleting === role.name;
        return (
          <div key={role.name} className="rounded-xl border border-border bg-panel p-5 space-y-4">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-panel2 px-2 py-0.5 text-xs font-mono text-muted">{role.name}</code>
                  {role.isSystem && (
                    <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                      system
                    </span>
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

            {/* Permissions */}
            <div className="border-t border-border pt-3">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Permissions</div>
              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {ALL_PERMISSIONS.map((perm) => (
                  <label key={perm} className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="accent-accent"
                      checked={perms.includes(perm)}
                      disabled={dis}
                      onChange={() => togglePerm(role.name, perm)}
                    />
                    <span className="min-w-0 truncate" title={perm}>
                      {PERMISSION_LABELS[perm] ?? perm}
                    </span>
                  </label>
                ))}
              </div>
            </div>

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
                  setCreateName(role.name + "_copy");
                  setCreateLabel(role.label + " (copy)");
                  setCloneFrom(role.name);
                  setShowCreate(true);
                }}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-text hover:bg-panel2"
              >
                <Copy className="h-3.5 w-3.5" /> Clone
              </button>
              {errors[role.name] && <p className="text-xs text-danger">{errors[role.name]}</p>}
              {saved[role.name] && <p className="text-xs text-green-400">Saved.</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
