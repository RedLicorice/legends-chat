"use client";
import { apiFetch } from "@/lib/fetch";

import { useCallback, useEffect, useState } from "react";
import { Copy, Plus, RefreshCw, Trash2, PowerOff, Power } from "lucide-react";
import { Toggle } from "@/components/ui/Toggle";

type Role = string;

interface InviteRow {
  id: string;
  code: string;
  role: Role;
  maxUses: number | null;
  usesCount: number;
  validFrom: string;
  expiresAt: string | null;
  disabledAt: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: { id: string; displayName: string } | null;
}

interface InvitesPayload {
  invites: InviteRow[];
  quota: { dailyLimit: number | null; usedToday: number };
  canCreateElevated: boolean;
  callerRole: Role;
}

export function InvitesPanel({ canCreateElevated }: { canCreateElevated: boolean }) {
  const [data, setData] = useState<InvitesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [justCopied, setJustCopied] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  // Form state
  const [role, setRole] = useState<Role>("user");
  const [maxUses, setMaxUses] = useState<string>("1");
  const [unlimited, setUnlimited] = useState(false);
  const [validFrom, setValidFrom] = useState<string>("");
  const [expiresAt, setExpiresAt] = useState<string>("");
  const [noExpiry, setNoExpiry] = useState(false);
  const [notes, setNotes] = useState<string>("");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/invites", { cache: "no-store" });
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function generate() {
    setCreating(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { role };
      if (notes.trim()) body.notes = notes.trim();
      if (validFrom) body.validFrom = new Date(validFrom).toISOString();
      if (noExpiry) {
        body.expiresAt = null;
      } else if (expiresAt) {
        body.expiresAt = new Date(expiresAt).toISOString();
      } else {
        body.expiresInDays = 7;
      }
      if (role === "user") body.maxUses = unlimited ? null : Math.max(1, Number(maxUses) || 1);
      const res = await apiFetch("/api/admin/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json()).error ?? "failed");
      await refresh();
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function deleteInvite(id: string) {
    setActing(id);
    try {
      await apiFetch(`/api/admin/invites/${id}`, { method: "DELETE" });
      await refresh();
    } finally {
      setActing(null);
    }
  }

  async function toggleDisable(id: string, currentlyDisabled: boolean) {
    setActing(id);
    try {
      await apiFetch(`/api/admin/invites/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ disabled: !currentlyDisabled }) });
      await refresh();
    } finally {
      setActing(null);
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setJustCopied(code);
      setTimeout(() => setJustCopied((c) => (c === code ? null : c)), 1500);
    } catch { /* ignore */ }
  }

  function describeUses(row: InviteRow): string {
    if (row.role !== "user") return row.usesCount >= 1 ? "used" : "unused";
    if (row.maxUses === null) return `${row.usesCount} / ∞`;
    return `${row.usesCount} / ${row.maxUses}`;
  }

  function describeStatus(row: InviteRow): { label: string; tone: string } {
    const now = Date.now();
    if (row.disabledAt) return { label: "disabled", tone: "text-warning" };
    if (row.validFrom && new Date(row.validFrom).getTime() > now) return { label: "not yet valid", tone: "text-muted" };
    if (row.expiresAt && new Date(row.expiresAt).getTime() < now) return { label: "expired", tone: "text-muted" };
    if (row.role !== "user" && row.usesCount >= 1) return { label: "used", tone: "text-muted" };
    if (row.maxUses !== null && row.usesCount >= row.maxUses) return { label: "used up", tone: "text-muted" };
    return { label: "active", tone: "text-accent2" };
  }

  return (
    <div className="space-y-6">
      {/* Create form */}
      <div className="rounded-xl border border-border bg-panel p-5">
        <h2 className="mb-4 text-sm uppercase tracking-wide text-muted">Generate a code</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}
              className="rounded-lg border border-border bg-panel2 px-3 py-2 text-sm text-text outline-none">
              <option value="user">User</option>
              {canCreateElevated && <option value="moderator">Moderator</option>}
              {canCreateElevated && <option value="admin">Admin</option>}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-muted">
            Max uses
            <div className="flex items-center gap-2">
              <input type="number" min={1} disabled={role !== "user" || unlimited}
                value={role === "user" ? maxUses : "1"} onChange={(e) => setMaxUses(e.target.value)}
                className="w-20 rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none disabled:opacity-50" />
              <div className="flex items-center gap-1 text-xs">
                <Toggle
                  disabled={role !== "user"}
                  checked={role === "user" && unlimited}
                  onChange={setUnlimited}
                  aria-label="Unlimited uses"
                /> ∞
              </div>
            </div>
            {role !== "user" && <span className="text-[10px] text-muted">(forced single-use)</span>}
          </label>

          <label className="flex flex-col gap-1 text-xs text-muted">
            Valid from
            <input type="datetime-local" value={validFrom} onChange={(e) => setValidFrom(e.target.value)}
              className="rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none" />
            <span className="text-[10px] text-muted">Leave blank = now</span>
          </label>

          <label className="flex flex-col gap-1 text-xs text-muted">
            Expires at
            <input type="datetime-local" disabled={noExpiry} value={noExpiry ? "" : expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none disabled:opacity-50" />
            <div className="flex items-center gap-1 text-xs">
              <Toggle
                checked={noExpiry}
                onChange={setNoExpiry}
                aria-label="No expiry"
              /> No expiry
            </div>
          </label>
        </div>
        <label className="mt-3 flex flex-col gap-1 text-xs text-muted">
          Notes (optional)
          <input type="text" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. for @username, community event, …"
            className="rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none" />
        </label>
        <div className="mt-3 flex items-center gap-3">
          <button type="button" onClick={generate} disabled={creating}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
            <Plus className="h-4 w-4" />
            {creating ? "Generating…" : "Generate"}
          </button>
          {data?.quota && data.quota.dailyLimit !== null && (
            <span className="text-xs text-muted">Daily quota: {data.quota.usedToday} / {data.quota.dailyLimit} used</span>
          )}
        </div>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </div>

      {/* List */}
      <div className="rounded-xl border border-border bg-panel">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm uppercase tracking-wide text-muted">Codes</h2>
          <button type="button" onClick={refresh} className="flex items-center gap-1 text-xs text-muted hover:text-text">
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
        {loading ? (
          <div className="p-5 text-sm text-muted">Loading…</div>
        ) : !data || data.invites.length === 0 ? (
          <div className="p-5 text-sm text-muted">No codes yet.</div>
        ) : (
          <ul className="divide-y divide-border">
            {data.invites.map((row) => {
              const status = describeStatus(row);
              const isActing = acting === row.id;
              const isDisabled = !!row.disabledAt;
              return (
                <li key={row.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <button type="button" onClick={() => copy(row.code)}
                    className="flex items-center gap-2 rounded-lg border border-border bg-panel2 px-3 py-1.5 font-mono text-sm hover:border-accent" title="Copy">
                    {row.code}
                    <Copy className="h-3 w-3 text-muted" />
                    {justCopied === row.code && <span className="text-xs text-accent2">copied</span>}
                  </button>
                  <div className="flex-1 min-w-0 text-xs text-muted flex flex-wrap gap-x-3 gap-y-0.5">
                    <span className="rounded bg-panel2 px-1.5 py-0.5 uppercase tracking-wide">{row.role}</span>
                    <span>{describeUses(row)}</span>
                    {row.validFrom && new Date(row.validFrom).getTime() > Date.now() && (
                      <span>valid from {new Date(row.validFrom).toLocaleString()}</span>
                    )}
                    {row.expiresAt && <span>expires {new Date(row.expiresAt).toLocaleString()}</span>}
                    {row.createdBy && <span>by {row.createdBy.displayName}</span>}
                    <span>{new Date(row.createdAt).toLocaleDateString()}</span>
                    {row.notes && <span className="italic">{row.notes}</span>}
                  </div>
                  <span className={`text-xs ${status.tone}`}>{status.label}</span>
                  <div className="flex gap-1">
                    <button type="button" title={isDisabled ? "Re-enable" : "Disable"} disabled={isActing}
                      onClick={() => toggleDisable(row.id, isDisabled)}
                      className="rounded-lg border border-border p-1.5 text-muted hover:border-warning hover:text-warning disabled:opacity-50">
                      {isDisabled ? <Power className="h-3.5 w-3.5" /> : <PowerOff className="h-3.5 w-3.5" />}
                    </button>
                    <button type="button" title="Delete" disabled={isActing}
                      onClick={() => deleteInvite(row.id)}
                      className="rounded-lg border border-border p-1.5 text-muted hover:border-danger hover:text-danger disabled:opacity-50">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
