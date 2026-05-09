"use client";

import { useEffect, useState } from "react";
import { Pencil, Trash2, Plus, X } from "lucide-react";

interface AdminSymbolRow {
  id: number;
  symbol: string;
  name: string;
  description: string | null;
  linkedUserId: string | null;
  linkedUserDisplayName: string | null;
  linkedUserAvatarUrl: string | null;
}

interface UserOption {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export function AdminSymbolsPanel() {
  const [rows, setRows] = useState<AdminSymbolRow[]>([]);
  const [editing, setEditing] = useState<AdminSymbolRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ symbol: "", name: "", description: "", linkedUserId: "" });
  const [userSearch, setUserSearch] = useState("");
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    fetch("/api/admin/symbols")
      .then((r) => r.json())
      .then(setRows)
      .catch(() => undefined);
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (userSearch.length < 2) { setUserOptions([]); return; }
    const t = setTimeout(() => {
      fetch(`/api/users?q=${encodeURIComponent(userSearch)}&limit=8`)
        .then((r) => r.ok ? r.json() : [])
        .then((data: UserOption[]) => setUserOptions(data))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [userSearch]);

  function openCreate() {
    setForm({ symbol: "", name: "", description: "", linkedUserId: "" });
    setUserSearch("");
    setUserOptions([]);
    setEditing(null);
    setCreating(true);
    setError(null);
  }

  function openEdit(row: AdminSymbolRow) {
    setForm({
      symbol: row.symbol,
      name: row.name,
      description: row.description ?? "",
      linkedUserId: row.linkedUserId ?? "",
    });
    setUserSearch(row.linkedUserDisplayName ?? "");
    setUserOptions([]);
    setEditing(row);
    setCreating(false);
    setError(null);
  }

  function closeForm() {
    setCreating(false);
    setEditing(null);
    setError(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        symbol: form.symbol.toLowerCase().trim(),
        name: form.name.trim(),
        description: form.description.trim() || null,
        linkedUserId: form.linkedUserId || null,
      };
      const url = editing ? `/api/admin/symbols/${editing.id}` : "/api/admin/symbols";
      const method = editing ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? "Save failed");
        return;
      }
      load();
      closeForm();
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("Delete this symbol? Historical messages keep the data but it stops rendering as styled.")) return;
    await fetch(`/api/admin/symbols/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted">Admin-defined $ticker symbols, optionally linked to a vendor user.</p>
        <button
          type="button"
          onClick={openCreate}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/80 transition"
        >
          <Plus className="h-4 w-4" /> New Symbol
        </button>
      </div>

      {(creating || editing) && (
        <div className="mb-6 rounded-xl border border-border bg-panel2 p-4">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-medium">{editing ? `Edit $${editing.symbol}` : "New Symbol"}</h3>
            <button type="button" onClick={closeForm}><X className="h-4 w-4 text-muted" /></button>
          </div>
          <div className="grid gap-3">
            <div className="flex items-center gap-2">
              <span className="text-muted font-mono text-sm">$</span>
              <input
                className="flex-1 rounded-lg border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
                placeholder="symbol (e.g. gv)"
                value={form.symbol}
                onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") }))}
              />
            </div>
            <input
              className="rounded-lg border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
              placeholder="Name (e.g. Green Valley)"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <textarea
              className="rounded-lg border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent resize-none"
              placeholder="Description (optional)"
              rows={2}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
            <div className="relative">
              <input
                className="w-full rounded-lg border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
                placeholder="Link to user (optional — type to search)"
                value={userSearch}
                onChange={(e) => { setUserSearch(e.target.value); if (!e.target.value) setForm((f) => ({ ...f, linkedUserId: "" })); }}
              />
              {userOptions.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-lg border border-border bg-panel shadow-lg">
                  {userOptions.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-panel2 transition"
                      onClick={() => {
                        setForm((f) => ({ ...f, linkedUserId: u.id }));
                        setUserSearch(u.displayName);
                        setUserOptions([]);
                      }}
                    >
                      {u.avatarUrl && <img src={u.avatarUrl} alt="" className="h-5 w-5 rounded-full object-cover" />}
                      {u.displayName}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={closeForm} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-border transition">Cancel</button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !form.symbol || !form.name}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/80 disabled:opacity-50 transition"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-panel2 text-muted text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-2 text-left">Symbol</th>
              <th className="px-4 py-2 text-left">Name</th>
              <th className="px-4 py-2 text-left">Linked User</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-muted">No symbols yet.</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-border hover:bg-panel2/50 transition">
                <td className="px-4 py-3 font-mono text-amber-400 font-semibold">${row.symbol}</td>
                <td className="px-4 py-3">
                  <div className="font-medium">{row.name}</div>
                  {row.description && <div className="text-xs text-muted">{row.description}</div>}
                </td>
                <td className="px-4 py-3">
                  {row.linkedUserDisplayName ? (
                    <div className="flex items-center gap-2">
                      {row.linkedUserAvatarUrl && <img src={row.linkedUserAvatarUrl} alt="" className="h-5 w-5 rounded-full object-cover" />}
                      {row.linkedUserDisplayName}
                    </div>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button type="button" onClick={() => openEdit(row)} className="rounded p-1.5 hover:bg-border transition"><Pencil className="h-3.5 w-3.5" /></button>
                    <button type="button" onClick={() => void remove(row.id)} className="rounded p-1.5 hover:bg-red-500/10 text-red-400 transition"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
