"use client";

import { useCallback, useEffect, useState } from "react";
import { Search, Pencil, Trash2, Ban, VolumeX, Check, X } from "lucide-react";
import { cn } from "@/lib/cn";

interface UserRow {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  isAnon: boolean;
  telegramUsername: string | null;
  email: string | null;
  createdAt: string;
}

const ROLES = ["user", "moderator", "admin"] as const;

export function AdminUsersForm({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editingName, setEditingName] = useState<{ id: string; value: string } | null>(null);
  const [banTarget, setBanTarget] = useState<{ id: string; type: "ban" | "mute" } | null>(null);
  const [banReason, setBanReason] = useState("");
  const [banDuration, setBanDuration] = useState("");
  const [banning, setBanning] = useState(false);

  const search = useCallback((q: string) => {
    setLoading(true);
    const url = q.trim() ? `/api/admin/users?q=${encodeURIComponent(q.trim())}` : "/api/admin/users";
    fetch(url)
      .then((r) => r.json())
      .then((data) => setUsers(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { search(""); }, [search]);
  useEffect(() => {
    const t = setTimeout(() => search(query), 300);
    return () => clearTimeout(t);
  }, [query, search]);

  async function setRole(userId: string, role: string) {
    setSaving(userId);
    setErrors((e) => ({ ...e, [userId]: "" }));
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error("failed");
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role } : u)));
    } catch {
      setErrors((e) => ({ ...e, [userId]: "Save failed" }));
    } finally {
      setSaving(null);
    }
  }

  async function saveName(userId: string, displayName: string) {
    setSaving(userId);
    setErrors((e) => ({ ...e, [userId]: "" }));
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      if (!res.ok) throw new Error("failed");
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, displayName } : u)));
      setEditingName(null);
    } catch {
      setErrors((e) => ({ ...e, [userId]: "Save failed" }));
    } finally {
      setSaving(null);
    }
  }

  async function deleteUser(userId: string, name: string) {
    if (!window.confirm(`Delete user "${name}"? This cannot be undone.`)) return;
    setDeleting(userId);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("failed");
      setUsers((prev) => prev.filter((u) => u.id !== userId));
    } catch {
      setErrors((e) => ({ ...e, [userId]: "Delete failed" }));
    } finally {
      setDeleting(null);
    }
  }

  async function applyBan() {
    if (!banTarget) return;
    setBanning(true);
    try {
      const endpoint = banTarget.type === "mute" ? "/api/admin/mute" : "/api/admin/ban";
      const body: Record<string, unknown> = {
        userId: banTarget.id,
        reason: banReason.trim() || null,
      };
      if (banDuration.trim()) {
        const hours = parseFloat(banDuration);
        if (!isNaN(hours) && hours > 0) {
          body.expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
        }
      }
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed");
      setBanTarget(null);
      setBanReason("");
      setBanDuration("");
    } catch {
      // silent — user can retry
    } finally {
      setBanning(false);
    }
  }

  return (
    <div>
      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or @username…"
          className="w-full rounded-xl border border-border bg-panel py-2 pl-9 pr-4 text-sm outline-none focus:border-accent placeholder:text-muted"
        />
      </div>

      {loading && <p className="text-sm text-muted">Loading…</p>}
      {!loading && users.length === 0 && <p className="text-sm text-muted">No users found.</p>}

      {/* Ban/mute dialog */}
      {banTarget && (
        <div className="mb-4 rounded-xl border border-border bg-panel p-4 space-y-3">
          <div className="text-sm font-medium">
            {banTarget.type === "mute" ? "Mute" : "Ban"}{" "}
            {users.find((u) => u.id === banTarget.id)?.displayName}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-muted">Reason (optional)</label>
              <input
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder="Reason…"
                className="w-full rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted">Duration in hours (blank = permanent)</label>
              <input
                value={banDuration}
                onChange={(e) => setBanDuration(e.target.value)}
                placeholder="e.g. 24"
                type="number"
                min="0"
                className="w-full rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={applyBan}
              disabled={banning}
              className="rounded-lg bg-danger px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {banning ? "Applying…" : `Apply ${banTarget.type}`}
            </button>
            <button
              onClick={() => { setBanTarget(null); setBanReason(""); setBanDuration(""); }}
              className="rounded-lg border border-border px-4 py-1.5 text-sm font-medium hover:bg-panel2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {users.map((u) => {
          const isSelf = u.id === currentUserId;
          const dis = saving === u.id || deleting === u.id;
          const isEditingThis = editingName?.id === u.id;
          return (
            <div key={u.id} className="rounded-xl border border-border bg-panel px-4 py-3 space-y-2">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent2 text-sm font-semibold text-white">
                  {u.avatarUrl ? (
                    <img src={u.avatarUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    u.displayName.slice(0, 1).toUpperCase()
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  {isEditingThis ? (
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        value={editingName.value}
                        onChange={(e) => setEditingName({ id: u.id, value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveName(u.id, editingName.value);
                          if (e.key === "Escape") setEditingName(null);
                        }}
                        className="rounded border border-border bg-panel2 px-2 py-1 text-sm outline-none focus:border-accent"
                      />
                      <button onClick={() => saveName(u.id, editingName.value)} disabled={dis} className="text-green-400 hover:opacity-80">
                        <Check className="h-4 w-4" />
                      </button>
                      <button onClick={() => setEditingName(null)} className="text-muted hover:opacity-80">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{u.displayName}</span>
                      {u.isAnon && <span className="rounded-full bg-panel2 px-1.5 py-0.5 text-[10px] text-muted">anon</span>}
                      {!isSelf && (
                        <button
                          onClick={() => setEditingName({ id: u.id, value: u.displayName })}
                          className="text-muted hover:text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                  <div className="flex gap-3 text-xs text-muted">
                    {u.telegramUsername && <span>@{u.telegramUsername}</span>}
                    {u.email && <span>{u.email}</span>}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {errors[u.id] && <span className="text-xs text-danger">{errors[u.id]}</span>}
                  <select
                    value={u.role}
                    disabled={dis || isSelf}
                    onChange={(e) => setRole(u.id, e.target.value)}
                    className={cn(
                      "rounded-lg border border-border bg-panel2 px-2 py-1 text-sm outline-none focus:border-accent disabled:opacity-50",
                      u.role === "admin" && "text-accent",
                      u.role === "moderator" && "text-accent2",
                    )}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>

                  {!isSelf && (
                    <>
                      <button
                        onClick={() => { setBanTarget({ id: u.id, type: "mute" }); setBanReason(""); setBanDuration(""); }}
                        disabled={dis}
                        title="Mute"
                        className="rounded-lg border border-border p-1.5 text-muted hover:border-accent hover:text-accent disabled:opacity-50"
                      >
                        <VolumeX className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => { setBanTarget({ id: u.id, type: "ban" }); setBanReason(""); setBanDuration(""); }}
                        disabled={dis}
                        title="Ban"
                        className="rounded-lg border border-border p-1.5 text-muted hover:border-danger hover:text-danger disabled:opacity-50"
                      >
                        <Ban className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => deleteUser(u.id, u.displayName)}
                        disabled={dis}
                        title="Delete user"
                        className="rounded-lg border border-border p-1.5 text-muted hover:border-danger hover:text-danger disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
