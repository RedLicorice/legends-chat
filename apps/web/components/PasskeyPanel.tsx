"use client";
import { apiFetch } from "@/lib/fetch";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Trash2, Plus, Pencil, Check, X, ShieldCheck } from "lucide-react";
import {
  startRegistration,
} from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";

interface PasskeyRow {
  id: string;
  name: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
}

export function PasskeyPanel() {
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [newName, setNewName] = useState("My Passkey");
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await apiFetch("/api/user/passkeys");
      if (r.ok) {
        const d = await r.json() as { passkeys: PasskeyRow[] };
        setPasskeys(d.passkeys);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function register() {
    setError(null);
    setRegistering(true);
    try {
      const optRes = await apiFetch("/api/auth/passkey/register");
      if (!optRes.ok) throw new Error("Failed to get registration options.");
      const options = await optRes.json() as PublicKeyCredentialCreationOptionsJSON;

      const response = await startRegistration({ optionsJSON: options });

      const verRes = await apiFetch("/api/auth/passkey/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response, name: newName.trim() || "Passkey" }),
      });
      const vd = await verRes.json() as { ok?: boolean; error?: string };
      if (!verRes.ok) throw new Error(vd.error ?? "Registration failed.");

      setShowAdd(false);
      setNewName("My Passkey");
      await load();
    } catch (e) {
      const err = e as Error;
      const isAbort = err.name === "AbortError" || err.message?.includes("cancelled") || err.message?.includes("The operation was aborted");
      if (!isAbort) {
        const isNotAllowed = err.name === "NotAllowedError" || err.message?.includes("NotAllowedError");
        setError(isNotAllowed ? "Not allowed — check your device has a screen lock enabled." : err.message ?? "Unknown error.");
      }
    } finally {
      setRegistering(false);
    }
  }

  async function remove(id: string) {
    try {
      await apiFetch("/api/user/passkeys", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setPasskeys((prev) => prev.filter((p) => p.id !== id));
    } catch {
      setError("Failed to remove passkey.");
    }
  }

  async function rename(id: string) {
    try {
      await apiFetch("/api/user/passkeys", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, name: editName }),
      });
      setPasskeys((prev) => prev.map((p) => p.id === id ? { ...p, name: editName } : p));
      setEditingId(null);
    } catch {
      setError("Failed to rename passkey.");
    }
  }

  if (loading) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="h-4 w-4 text-muted" />
          <span>Passkeys</span>
        </div>
        {!showAdd && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-accent hover:bg-panel2"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        )}
      </div>

      {passkeys.length === 0 && !showAdd && (
        <p className="text-xs text-muted">No passkeys yet. Add one to sign in without a password.</p>
      )}

      {passkeys.map((pk) => (
        <div key={pk.id} className="flex items-center gap-2 rounded-lg border border-border bg-panel2 px-3 py-2">
          {pk.backedUp && <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-green-500" aria-label="Backed up" />}
          {!pk.backedUp && <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted" />}
          {editingId === pk.id ? (
            <>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                maxLength={64}
                className="min-w-0 flex-1 rounded border border-border bg-panel px-2 py-0.5 text-xs outline-none focus:border-accent"
                autoFocus
              />
              <button type="button" onClick={() => rename(pk.id)} className="text-green-500 hover:opacity-80"><Check className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => setEditingId(null)} className="text-muted hover:text-text"><X className="h-3.5 w-3.5" /></button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-xs">{pk.name}</span>
              <span className="shrink-0 text-[10px] text-muted">{new Date(pk.createdAt).toLocaleDateString()}</span>
              <button type="button" onClick={() => { setEditingId(pk.id); setEditName(pk.name); }} className="text-muted hover:text-text">
                <Pencil className="h-3 w-3" />
              </button>
              <button type="button" onClick={() => remove(pk.id)} className="text-muted hover:text-danger">
                <Trash2 className="h-3 w-3" />
              </button>
            </>
          )}
        </div>
      ))}

      {showAdd && (
        <div className="space-y-2 rounded-lg border border-border bg-panel2 p-3">
          <p className="text-xs text-muted">Name this passkey (optional)</p>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={64}
            placeholder="My Passkey"
            className="w-full rounded-md border border-border bg-panel px-2 py-1.5 text-xs outline-none focus:border-accent"
            autoFocus
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={register}
              disabled={registering}
              className="flex-1 rounded-lg bg-accent py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {registering ? "Follow browser prompt…" : "Register passkey"}
            </button>
            <button type="button" onClick={() => { setShowAdd(false); setError(null); }} className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-panel">
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
