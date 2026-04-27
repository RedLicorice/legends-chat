"use client";

import { useState } from "react";
import { KeyRound, X } from "lucide-react";
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";

export function PasskeyBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addPasskey() {
    setRegistering(true);
    setError(null);
    try {
      const optRes = await fetch("/api/auth/passkey/register");
      if (!optRes.ok) throw new Error("Failed to get registration options.");
      const options = await optRes.json() as PublicKeyCredentialCreationOptionsJSON;
      const response = await startRegistration({ optionsJSON: options });
      const verRes = await fetch("/api/auth/passkey/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response, name: "My Passkey" }),
      });
      const vd = await verRes.json() as { ok?: boolean; error?: string };
      if (!verRes.ok) throw new Error(vd.error ?? "Registration failed.");
      setDone(true);
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.includes("cancelled") && !msg.includes("AbortError") && !msg.includes("NotAllowedError")) {
        setError(msg);
      }
    } finally {
      setRegistering(false);
    }
  }

  if (dismissed) return null;

  if (done) {
    return (
      <div className="flex items-center gap-3 border-b border-border bg-green-900/20 px-4 py-2 text-sm text-green-400">
        <KeyRound className="h-4 w-4 shrink-0" />
        Passkey added successfully.
        <button onClick={() => setDismissed(true)} className="ml-auto"><X className="h-4 w-4" /></button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-panel2 px-4 py-2 text-sm">
      <KeyRound className="h-4 w-4 shrink-0 text-accent" />
      <span className="flex-1 text-muted">Add a passkey to secure your account.</span>
      {error && <span className="text-xs text-danger">{error}</span>}
      <button
        onClick={addPasskey}
        disabled={registering}
        className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {registering ? "Follow browser prompt…" : "Add passkey"}
      </button>
      <button onClick={() => setDismissed(true)} className="text-muted hover:text-text" title="Dismiss">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
