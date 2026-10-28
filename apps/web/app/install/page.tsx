"use client";
import { useEffect, useState, FormEvent } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { Loader2, KeyRound } from "lucide-react";
import { apiFetch } from "@/lib/fetch";
import { clearSessionId } from "@/lib/e2ee-session";

// First-run setup: creates the admin account and its first passkey. Reachable
// only with a token printed by `install-unlock.ts` (shell access required).
export default function InstallPage() {
  const [token, setToken] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token");
    setToken(t);
    // Keep the secret out of history/referrers once we have it in memory.
    if (t) window.history.replaceState(null, "", "/install");
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError(null);
    setBusy(true);
    try {
      const optRes = await apiFetch("/api/install/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, displayName: displayName.trim() }),
      });
      const opts = (await optRes.json()) as PublicKeyCredentialCreationOptionsJSON & { error?: string };
      if (!optRes.ok) throw new Error(opts.error ?? "Could not start setup.");

      const response = await startRegistration({ optionsJSON: opts });

      const verRes = await apiFetch("/api/install/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, response, name: "First passkey" }),
      });
      const vd = (await verRes.json()) as { ok?: boolean; error?: string };
      if (!verRes.ok) throw new Error(vd.error ?? "Setup failed.");

      clearSessionId();
      window.location.replace("/");
    } catch (err) {
      const e2 = err as Error;
      setError(e2.name === "NotAllowedError" ? "Passkey prompt was cancelled." : e2.message);
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">Install</h1>
        {token === null ? (
          <p className="text-sm text-muted">
            This page is locked. Run the install-unlock command on the server and open the link it prints.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">Create the first admin account and register its passkey.</p>
            <input
              className="w-full rounded border px-3 py-2 bg-transparent"
              placeholder="Display name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={64}
              required
              autoFocus
            />
            <button
              type="submit"
              disabled={busy || !displayName.trim()}
              className="w-full rounded px-3 py-2 flex items-center justify-center gap-2 border"
            >
              {busy ? <Loader2 className="animate-spin" size={16} /> : <KeyRound size={16} />}
              {busy ? "Follow the passkey prompt…" : "Create admin & register passkey"}
            </button>
            {error && <p className="text-sm text-red-500">{error}</p>}
          </>
        )}
      </form>
    </main>
  );
}
