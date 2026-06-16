"use client";
import { apiFetch } from "@/lib/fetch";

import { useCallback, useEffect, useState } from "react";
import { Search, Pencil, Trash2, Ban, VolumeX, Check, X, Info, Copy, Plus, Link as LinkIcon } from "lucide-react";
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
  isBanned: boolean;
  banExpiresAt: string | null;
  isMuted: boolean;
  muteExpiresAt: string | null;
}

interface BanMuteRecord {
  id: string;
  reason: string;
  createdAt: string;
  expiresAt: string | null;
  liftedAt: string | null;
}

interface UserDetails {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  role: string;
  roleExpiresAt: string | null;
  roleFallback: string | null;
  email: string | null;
  telegramUsername: string | null;
  isAnon: boolean;
  presenceOptOut: boolean;
  createdAt: string;
  passkeys: { id: string; name: string; deviceType: string; createdAt: string }[];
  activeBans: BanMuteRecord[];
  activeMutes: BanMuteRecord[];
  bansHistory: BanMuteRecord[];
  mutesHistory: BanMuteRecord[];
}

interface Override {
  id: string;
  permission: string;
  effect: string;
  expiresAt: string | null;
}

interface ActivityEvent {
  type:
    | "session_created"
    | "session_revoked"
    | "ban_applied"
    | "ban_lifted"
    | "mute_applied"
    | "mute_lifted"
    | "topic_joined"
    | "message_activity";
  timestamp: string;
  description: string;
  meta?: Record<string, string | number | null>;
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
  const [banError, setBanError] = useState<string | null>(null);
  const [detailsUserId, setDetailsUserId] = useState<string | null>(null);
  const [details, setDetails] = useState<UserDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [activity, setActivity] = useState<ActivityEvent[] | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityLimit, setActivityLimit] = useState(30);
  const [roleForm, setRoleForm] = useState({ role: "", roleExpiresAt: "", roleFallback: "" });
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [overridesLoading, setOverridesLoading] = useState(false);

  // "Create user" inline form state.
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createRole, setCreateRole] = useState<"user" | "admin">("user");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Per-user login-link state. Keyed by userId so opening details on a
  // different row doesn't surface a stale link.
  const [loginLink, setLoginLink] = useState<
    | { userId: string; url: string; expiresAt: string }
    | null
  >(null);
  const [loginLinkBusy, setLoginLinkBusy] = useState(false);
  const [loginLinkError, setLoginLinkError] = useState<string | null>(null);
  const [loginLinkCopied, setLoginLinkCopied] = useState(false);

  const search = useCallback((q: string) => {
    setLoading(true);
    const url = q.trim() ? `/api/admin/users?q=${encodeURIComponent(q.trim())}` : "/api/admin/users";
    apiFetch(url)
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
      const res = await apiFetch(`/api/admin/users/${userId}`, {
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
      const res = await apiFetch(`/api/admin/users/${userId}`, {
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
      const res = await apiFetch(`/api/admin/users/${userId}`, { method: "DELETE" });
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
      let durationSeconds: number | null = null;
      if (banDuration.trim()) {
        const hours = parseFloat(banDuration);
        if (!isNaN(hours) && hours > 0) durationSeconds = Math.round(hours * 3600);
      }
      const body: Record<string, unknown> = {
        userId: banTarget.id,
        reason: banReason.trim() || "No reason provided",
        durationSeconds,
      };
      const res = await apiFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      setBanTarget(null);
      setBanReason("");
      setBanDuration("");
      setBanError(null);
    } catch (e) {
      setBanError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBanning(false);
    }
  }

  const fetchActivity = useCallback(async (userId: string, limit: number) => {
    setActivityLoading(true);
    try {
      const res = await apiFetch(`/api/admin/users/${userId}/activity?limit=${limit}`);
      if (res.ok) setActivity(await res.json());
      else setActivity([]);
    } catch {
      setActivity([]);
    } finally {
      setActivityLoading(false);
    }
  }, []);

  async function openDetails(userId: string) {
    setDetailsUserId(userId);
    setDetails(null);
    setDetailsLoading(true);
    setActivity(null);
    setOverrides([]);
    try {
      const [detailsRes] = await Promise.all([
        apiFetch(`/api/admin/users/${userId}`),
        fetchActivity(userId, activityLimit),
      ]);
      if (detailsRes.ok) {
        const detailsData: UserDetails = await detailsRes.json();
        setDetails(detailsData);
        setRoleForm({
          role: detailsData.role ?? "",
          roleExpiresAt: detailsData.roleExpiresAt ? new Date(detailsData.roleExpiresAt).toISOString().slice(0, 16) : "",
          roleFallback: detailsData.roleFallback ?? "",
        });
        setOverridesLoading(true);
        const ovRes = await apiFetch(`/api/admin/users/${userId}/permission-overrides`);
        const ovData = await ovRes.json() as { overrides: Override[] };
        setOverrides(ovData.overrides ?? []);
        setOverridesLoading(false);
      }
    } finally {
      setDetailsLoading(false);
    }
  }

  useEffect(() => {
    if (detailsUserId) {
      fetchActivity(detailsUserId, activityLimit);
    }
  }, [activityLimit, detailsUserId, fetchActivity]);

  const generateLoginLink = useCallback(
    async (userId: string) => {
      setLoginLinkBusy(true);
      setLoginLinkError(null);
      setLoginLinkCopied(false);
      try {
        const res = await apiFetch(`/api/admin/users/${userId}/login-link`, {
          method: "POST",
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(body || `Failed (${res.status})`);
        }
        const data = (await res.json()) as { url: string; expiresAt: string };
        setLoginLink({ userId, url: data.url, expiresAt: data.expiresAt });
      } catch (e) {
        setLoginLinkError(e instanceof Error ? e.message : "Failed");
      } finally {
        setLoginLinkBusy(false);
      }
    },
    [],
  );

  async function createUser() {
    const name = createName.trim();
    if (!name) {
      setCreateError("Display name is required");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiFetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: name, role: createRole }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `Failed (${res.status})`);
      }
      const created = (await res.json()) as {
        id: string;
        displayName: string;
        role: string;
      };

      // Prepend a stub row so the list reflects the new user without a
      // refetch. The next search refresh will replace it with the canonical
      // shape including ban/mute flags (all defaults are false for a fresh
      // user so the UI rendering is correct).
      const stub: UserRow = {
        id: created.id,
        displayName: created.displayName,
        avatarUrl: null,
        role: created.role,
        isAnon: false,
        telegramUsername: null,
        email: null,
        createdAt: new Date().toISOString(),
        isBanned: false,
        banExpiresAt: null,
        isMuted: false,
        muteExpiresAt: null,
      };
      setUsers((prev) => [stub, ...prev.filter((u) => u.id !== stub.id)]);

      // Reset the create form and auto-open details — a freshly-created
      // user has no auth path yet, so we immediately mint a login link.
      setCreateOpen(false);
      setCreateName("");
      setCreateRole("user");
      await openDetails(created.id);
      void generateLoginLink(created.id);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Failed");
    } finally {
      setCreating(false);
    }
  }

  // Clear the login link surface whenever the details target changes —
  // a link generated for user A must not survive into user B's panel.
  useEffect(() => {
    setLoginLink(null);
    setLoginLinkError(null);
    setLoginLinkCopied(false);
  }, [detailsUserId]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or @username…"
            className="w-full rounded-xl border border-border bg-panel py-2 pl-9 pr-4 text-sm outline-none focus:border-accent placeholder:text-muted"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            setCreateOpen((v) => !v);
            setCreateError(null);
          }}
          className="flex items-center gap-1.5 rounded-xl border border-border bg-panel px-3 py-2 text-sm font-medium hover:border-accent hover:text-accent"
        >
          <Plus className="h-4 w-4" />
          New user
        </button>
      </div>

      {createOpen && (
        <div className="mb-4 rounded-xl border border-border bg-panel p-4 space-y-3">
          <div className="text-sm font-medium">Create user</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-muted">Display name</label>
              <input
                autoFocus
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createUser();
                  if (e.key === "Escape") setCreateOpen(false);
                }}
                placeholder="e.g. Alice"
                maxLength={40}
                className="w-full rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted">Role</label>
              <select
                value={createRole}
                onChange={(e) => setCreateRole(e.target.value as "user" | "admin")}
                className="w-full rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent"
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </div>
          </div>
          {createError && <p className="text-sm text-danger">{createError}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void createUser()}
              disabled={creating || !createName.trim()}
              className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create user"}
            </button>
            <button
              type="button"
              onClick={() => { setCreateOpen(false); setCreateError(null); }}
              className="rounded-lg border border-border px-4 py-1.5 text-sm font-medium hover:bg-panel2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading && <p className="text-sm text-muted">Loading…</p>}
      {!loading && users.length === 0 && <p className="text-sm text-muted">No users found.</p>}

      {/* Ban/mute dialog */}
      {banTarget && (
        <div className="mb-4 rounded-xl border border-border bg-panel p-4 space-y-3">
          <div className="text-sm font-medium">
            {banTarget.type === "mute" ? "Mute" : "Ban"}{" "}
            {users.find((u) => u.id === banTarget.id)?.displayName}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
          {banError && <p className="text-sm text-danger">{banError}</p>}
          <div className="flex gap-2">
            <button
              onClick={applyBan}
              disabled={banning}
              className="rounded-lg bg-danger px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {banning ? "Applying…" : `Apply ${banTarget.type}`}
            </button>
            <button
              onClick={() => { setBanTarget(null); setBanReason(""); setBanDuration(""); setBanError(null); }}
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
              {/* Row 1: avatar + name/email */}
              <div className="flex items-center gap-3 min-w-0">
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
                          className="shrink-0 text-muted hover:text-text"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
                    {u.isBanned && (
                      <span className="rounded-full bg-danger/20 px-1.5 py-0.5 text-[10px] font-medium text-danger">
                        BANNED{u.banExpiresAt ? ` until ${new Date(u.banExpiresAt).toLocaleDateString()}` : ""}
                      </span>
                    )}
                    {u.isMuted && (
                      <span className="rounded-full bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                        MUTED{u.muteExpiresAt ? ` until ${new Date(u.muteExpiresAt).toLocaleDateString()}` : ""}
                      </span>
                    )}
                    {u.telegramUsername && <span>@{u.telegramUsername}</span>}
                    {u.email && <span className="truncate max-w-[180px]">{u.email}</span>}
                    <span>{new Date(u.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>

              {/* Row 2: role select + action buttons */}
              <div className="flex flex-wrap items-center gap-2">
                {errors[u.id] && <span className="w-full text-xs text-danger">{errors[u.id]}</span>}
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
                <div className="ml-auto flex gap-1.5">
                  <button
                    onClick={() => void navigator.clipboard.writeText(u.id)}
                    title={`Copy ID: ${u.id}`}
                    className="rounded-lg border border-border p-1.5 text-muted hover:border-accent hover:text-accent"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => openDetails(u.id)}
                    title="Details"
                    className="rounded-lg border border-border p-1.5 text-muted hover:border-accent hover:text-accent"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
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

      {/* User details modal */}
      {detailsUserId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => { setDetailsUserId(null); setActivity(null); }}>
          <div className="w-full max-w-lg rounded-xl border border-border bg-panel p-5 shadow-xl max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">User Details</h2>
              <button onClick={() => { setDetailsUserId(null); setActivity(null); }} className="text-muted hover:text-text"><X className="h-4 w-4" /></button>
            </div>
            {detailsLoading && <p className="text-sm text-muted">Loading…</p>}
            {details && (
              <div className="space-y-4 text-sm">
                <div className="flex items-center gap-3">
                  {details.avatarUrl && <img src={details.avatarUrl} className="h-12 w-12 rounded-full object-cover" alt="" />}
                  <div>
                    <p className="font-medium">{details.displayName}</p>
                    <p className="text-xs text-muted capitalize">{details.isAnon ? "anon" : ""}</p>
                  </div>
                </div>
                <div className="mt-4">
                  <h4 className="mb-2 text-xs font-semibold text-muted uppercase tracking-wide">Role</h4>
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <label className="block text-xs text-muted mb-0.5">Role</label>
                      <select
                        className="rounded border border-border bg-panel px-2 py-1 text-sm"
                        value={roleForm.role}
                        onChange={(e) => setRoleForm((r) => ({ ...r, role: e.target.value }))}
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-muted mb-0.5">Expires (optional)</label>
                      <input
                        type="datetime-local"
                        className="rounded border border-border bg-panel px-2 py-1 text-sm"
                        value={roleForm.roleExpiresAt}
                        onChange={(e) => setRoleForm((r) => ({ ...r, roleExpiresAt: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-muted mb-0.5">Reverts to</label>
                      <select
                        className="rounded border border-border bg-panel px-2 py-1 text-sm"
                        value={roleForm.roleFallback}
                        onChange={(e) => setRoleForm((r) => ({ ...r, roleFallback: e.target.value }))}
                      >
                        <option value="">— none —</option>
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                    <button
                      type="button"
                      className="rounded bg-accent px-3 py-1.5 text-sm text-white"
                      onClick={async () => {
                        await apiFetch(`/api/admin/users/${detailsUserId}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            role: roleForm.role || undefined,
                            roleExpiresAt: roleForm.roleExpiresAt || null,
                            roleFallback: roleForm.roleFallback || null,
                          }),
                        });
                      }}
                    >
                      Save role
                    </button>
                    {roleForm.roleExpiresAt && (
                      <button
                        type="button"
                        className="text-xs text-muted hover:text-text"
                        onClick={async () => {
                          await apiFetch(`/api/admin/users/${detailsUserId}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ roleExpiresAt: null, roleFallback: null }),
                          });
                          setRoleForm((r) => ({ ...r, roleExpiresAt: "", roleFallback: "" }));
                        }}
                      >
                        Clear expiry
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-4">
                  <h4 className="mb-2 text-xs font-semibold text-muted uppercase tracking-wide">Permission Overrides</h4>
                  {overridesLoading ? (
                    <p className="text-xs text-muted">Loading…</p>
                  ) : (
                    <>
                      {overrides.length > 0 && (
                        <table className="w-full text-xs mb-3">
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
                              <tr key={o.permission} className={o.expiresAt && new Date(o.expiresAt) < new Date() ? "opacity-40" : ""}>
                                <td className="pr-2 py-0.5 font-mono text-[11px]">{o.permission}</td>
                                <td className={`pr-2 py-0.5 font-medium ${o.effect === "allow" ? "text-green-500" : "text-red-500"}`}>{o.effect}</td>
                                <td className="pr-2 py-0.5">{o.expiresAt ? new Date(o.expiresAt).toLocaleDateString() : "—"}</td>
                                <td className="py-0.5">
                                  <button
                                    type="button"
                                    className="text-muted hover:text-red-500 transition"
                                    onClick={async () => {
                                      await apiFetch(`/api/admin/users/${detailsUserId}/permission-overrides`, {
                                        method: "DELETE",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ permission: o.permission }),
                                      });
                                      setOverrides((ov) => ov.filter((x) => x.permission !== o.permission));
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
                      <UserAddOverrideForm
                        onAdd={async (permission, effect, expiresAt) => {
                          const res = await apiFetch(`/api/admin/users/${detailsUserId}/permission-overrides`, {
                            method: "PUT",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ permission, effect, expiresAt }),
                          });
                          const data = await res.json() as { override: Override };
                          setOverrides((ov) => [...ov.filter((x) => x.permission !== permission), data.override]);
                        }}
                      />
                    </>
                  )}
                </div>
                <table className="w-full text-xs border-collapse">
                  <tbody>
                    {[
                      ["ID", details.id],
                      ["Email", details.email ?? "—"],
                      ["Telegram", details.telegramUsername ? `@${details.telegramUsername}` : "—"],
                      ["Joined", new Date(details.createdAt).toLocaleString()],
                      ["Presence opt-out", details.presenceOptOut ? "Yes" : "No"],
                      ["Passkeys", details.passkeys.length > 0 ? details.passkeys.map(p => `${p.name} (${p.deviceType})`).join(", ") : "None"],
                    ].map(([label, value]) => (
                      <tr key={label} className="border-b border-border">
                        <td className="py-1.5 pr-3 text-muted w-24">{label}</td>
                        <td className="py-1.5 break-all">{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* Login link generator — privileged surface, gated server-side on admin.config. */}
                <div className="mt-4">
                  <h4 className="mb-2 text-xs font-semibold text-muted uppercase tracking-wide">Login link</h4>
                  <p className="mb-2 text-xs text-muted">
                    Anyone with this link can log in as this user until it&apos;s used or expires.
                    Send through a private channel.
                  </p>
                  {loginLink && loginLink.userId === detailsUserId ? (
                    <div className="space-y-2">
                      <div className="flex items-stretch gap-2">
                        <input
                          readOnly
                          value={loginLink.url}
                          onFocus={(e) => e.currentTarget.select()}
                          className="flex-1 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-xs font-mono outline-none"
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(loginLink.url);
                              setLoginLinkCopied(true);
                              setTimeout(() => setLoginLinkCopied(false), 1500);
                            } catch {
                              setLoginLinkError("Copy failed");
                            }
                          }}
                          className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:border-accent hover:text-accent"
                        >
                          {loginLinkCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                          {loginLinkCopied ? "Copied" : "Copy"}
                        </button>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted">
                          {formatExpiresIn(loginLink.expiresAt)}
                        </span>
                        <button
                          type="button"
                          onClick={() => void generateLoginLink(detailsUserId!)}
                          disabled={loginLinkBusy}
                          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:border-accent hover:text-accent disabled:opacity-50"
                        >
                          {loginLinkBusy ? "Regenerating…" : "Regenerate"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void generateLoginLink(detailsUserId!)}
                      disabled={loginLinkBusy}
                      className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      <LinkIcon className="h-3.5 w-3.5" />
                      {loginLinkBusy ? "Generating…" : "Generate link"}
                    </button>
                  )}
                  {loginLinkError && (
                    <p className="mt-2 text-xs text-danger">{loginLinkError}</p>
                  )}
                </div>
                {details.activeBans.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-danger uppercase tracking-wide">Active Bans</p>
                    {details.activeBans.map((b) => (
                      <div key={b.id} className="rounded-lg border border-border bg-panel2 px-3 py-2 text-xs mb-1">
                        <p>{b.reason}</p>
                        <p className="text-muted">{new Date(b.createdAt).toLocaleString()}{b.expiresAt ? ` · until ${new Date(b.expiresAt).toLocaleString()}` : " · permanent"}</p>
                      </div>
                    ))}
                  </div>
                )}
                {details.activeMutes.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-warning uppercase tracking-wide">Active Mutes</p>
                    {details.activeMutes.map((m) => (
                      <div key={m.id} className="rounded-lg border border-border bg-panel2 px-3 py-2 text-xs mb-1">
                        <p>{m.reason}</p>
                        <p className="text-muted">{new Date(m.createdAt).toLocaleString()}{m.expiresAt ? ` · until ${new Date(m.expiresAt).toLocaleString()}` : " · permanent"}</p>
                      </div>
                    ))}
                  </div>
                )}
                {details.bansHistory.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted hover:text-text">Ban history ({details.bansHistory.length})</summary>
                    <div className="mt-2 space-y-1">
                      {details.bansHistory.map((b) => (
                        <div key={b.id} className="rounded-lg border border-border bg-panel2 px-3 py-2">
                          <p>{b.reason}</p>
                          <p className="text-muted">{new Date(b.createdAt).toLocaleString()}{b.liftedAt ? ` · lifted ${new Date(b.liftedAt).toLocaleString()}` : b.expiresAt ? ` · until ${new Date(b.expiresAt).toLocaleString()}` : ""}</p>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                {details.mutesHistory.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted hover:text-text">Mute history ({details.mutesHistory.length})</summary>
                    <div className="mt-2 space-y-1">
                      {details.mutesHistory.map((m) => (
                        <div key={m.id} className="rounded-lg border border-border bg-panel2 px-3 py-2">
                          <p>{m.reason}</p>
                          <p className="text-muted">{new Date(m.createdAt).toLocaleString()}{m.liftedAt ? ` · lifted ${new Date(m.liftedAt).toLocaleString()}` : m.expiresAt ? ` · until ${new Date(m.expiresAt).toLocaleString()}` : ""}</p>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                {/* Activity Log */}
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-medium text-muted uppercase tracking-wide">Activity Log</p>
                    <select
                      value={activityLimit}
                      onChange={(e) => setActivityLimit(Number(e.target.value))}
                      className="rounded border border-border bg-panel2 px-1.5 py-0.5 text-xs outline-none focus:border-accent"
                    >
                      {[30, 50, 100].map((n) => (
                        <option key={n} value={n}>Show: {n}</option>
                      ))}
                    </select>
                  </div>
                  {activityLoading && <p className="text-xs text-muted">Loading…</p>}
                  {!activityLoading && activity !== null && activity.length === 0 && (
                    <p className="text-xs text-muted">No activity recorded.</p>
                  )}
                  {!activityLoading && activity && activity.length > 0 && (
                    <ul className="space-y-1 text-xs">
                      {activity.map((ev, i) => (
                        <li key={i} className="flex gap-2 items-start border-b border-border/50 pb-1 last:border-0">
                          <span className="shrink-0 text-muted w-36">
                            {new Date(ev.timestamp).toLocaleString()}
                          </span>
                          <span className="break-words min-w-0">{ev.description}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatExpiresIn(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "Expired";
  const totalSeconds = Math.floor(diffMs / 1000);
  if (totalSeconds < 60) return `Expires in ${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0
      ? `Expires in ${minutes}m ${seconds}s`
      : `Expires in ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin > 0
    ? `Expires in ${hours}h ${remMin}m`
    : `Expires in ${hours}h`;
}

function UserAddOverrideForm({ onAdd }: { onAdd: (permission: string, effect: string, expiresAt: string | null) => Promise<void> }) {
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
        className="rounded border border-border bg-panel px-2 py-1 text-xs font-mono w-52"
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
        onClick={submit}
        disabled={saving}
        className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50"
      >
        {saving ? "…" : "Add Override"}
      </button>
    </div>
  );
}
