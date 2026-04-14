"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Plus, RefreshCw } from "lucide-react";

type Role = "user" | "moderator" | "admin";

interface InviteRow {
  id: string;
  code: string;
  role: Role;
  maxUses: number | null;
  usesCount: number;
  expiresAt: string | null;
  createdAt: string;
  createdBy: { id: string; displayName: string } | null;
}

interface InvitesPayload {
  invites: InviteRow[];
  quota: { dailyLimit: number; usedToday: number };
  canCreateElevated: boolean;
  callerRole: Role;
}

export function InvitesPanel({ canCreateElevated }: { canCreateElevated: boolean }) {
  const [data, setData] = useState<InvitesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [justCopied, setJustCopied] = useState<string | null>(null);

  // Form state
  const [role, setRole] = useState<Role>("user");
  const [maxUses, setMaxUses] = useState<string>("1");
  const [unlimited, setUnlimited] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<string>("7");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/invites", { cache: "no-store" });
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function generate() {
    setCreating(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        role,
        expiresInDays: Number(expiresInDays) || 7,
      };
      if (role === "user") {
        body.maxUses = unlimited ? null : Math.max(1, Number(maxUses) || 1);
      }
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "failed");
      await refresh();
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setJustCopied(code);
      setTimeout(() => setJustCopied((c) => (c === code ? null : c)), 1500);
    } catch {
      // ignore
    }
  }

  function describeUses(row: InviteRow): string {
    if (row.role !== "user") return row.usesCount >= 1 ? "used" : "unused";
    if (row.maxUses === null) return `${row.usesCount} / ∞`;
    return `${row.usesCount} / ${row.maxUses}`;
  }

  function describeStatus(row: InviteRow): { label: string; tone: string } {
    const now = Date.now();
    if (row.expiresAt && new Date(row.expiresAt).getTime() < now) {
      return { label: "expired", tone: "text-muted" };
    }
    if (row.role !== "user" && row.usesCount >= 1) {
      return { label: "used", tone: "text-muted" };
    }
    if (row.maxUses !== null && row.usesCount >= row.maxUses) {
      return { label: "used up", tone: "text-muted" };
    }
    return { label: "active", tone: "text-accent2" };
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-panel p-5">
        <h2 className="mb-4 text-sm uppercase tracking-wide text-muted">Generate a code</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Role
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="rounded-lg border border-border bg-panel2 px-3 py-2 text-sm text-text outline-none"
            >
              <option value="user">User</option>
              {canCreateElevated && <option value="moderator">Moderator</option>}
              {canCreateElevated && <option value="admin">Admin</option>}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-muted">
            Max uses
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                disabled={role !== "user" || unlimited}
                value={role === "user" ? maxUses : "1"}
                onChange={(e) => setMaxUses(e.target.value)}
                className="w-20 rounded-lg border border-border bg-panel2 px-3 py-2 text-sm text-text outline-none disabled:opacity-50"
              />
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  disabled={role !== "user"}
                  checked={role === "user" && unlimited}
                  onChange={(e) => setUnlimited(e.target.checked)}
                />
                ∞
              </label>
            </div>
            {role !== "user" && (
              <span className="text-[10px] text-muted">(forced single-use)</span>
            )}
          </label>

          <label className="flex flex-col gap-1 text-xs text-muted">
            Expires in (days)
            <input
              type="number"
              min={1}
              max={365}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              className="rounded-lg border border-border bg-panel2 px-3 py-2 text-sm text-text outline-none"
            />
          </label>

          <div className="flex items-end">
            <button
              type="button"
              onClick={generate}
              disabled={creating}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {creating ? "Generating…" : "Generate"}
            </button>
          </div>
        </div>
        {data?.quota && (
          <p className="mt-3 text-xs text-muted">
            Daily quota: {data.quota.usedToday} / {data.quota.dailyLimit} used today
          </p>
        )}
        {error && <p className="mt-3 text-xs text-danger">{error}</p>}
      </div>

      <div className="rounded-xl border border-border bg-panel">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm uppercase tracking-wide text-muted">Codes</h2>
          <button
            type="button"
            onClick={refresh}
            className="flex items-center gap-1 text-xs text-muted hover:text-text"
          >
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
              return (
                <li key={row.id} className="flex items-center gap-4 px-5 py-3">
                  <button
                    type="button"
                    onClick={() => copy(row.code)}
                    className="flex items-center gap-2 rounded-lg border border-border bg-panel2 px-3 py-1.5 font-mono text-sm hover:border-accent"
                    title="Copy"
                  >
                    {row.code}
                    <Copy className="h-3 w-3 text-muted" />
                  </button>
                  <div className="flex-1 text-xs text-muted">
                    <span className="rounded bg-panel2 px-1.5 py-0.5 uppercase tracking-wide">
                      {row.role}
                    </span>
                    <span className="ml-2">{describeUses(row)}</span>
                    {row.expiresAt && (
                      <span className="ml-2">
                        · expires {new Date(row.expiresAt).toLocaleDateString()}
                      </span>
                    )}
                    {row.createdBy && <span className="ml-2">· by {row.createdBy.displayName}</span>}
                  </div>
                  <span className={`text-xs ${status.tone}`}>{status.label}</span>
                  {justCopied === row.code && (
                    <span className="text-xs text-accent2">copied</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
