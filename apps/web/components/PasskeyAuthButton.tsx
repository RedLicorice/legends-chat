"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { cn } from "@/lib/cn";

interface Props {
  onSuccess?: () => void;
  className?: string;
}

export function PasskeyAuthButton({ onSuccess, className }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function authenticate() {
    setError(null);
    setLoading(true);
    try {
      const optRes = await fetch("/api/auth/passkey/authenticate");
      if (!optRes.ok) throw new Error("Failed to get authentication options.");
      const options = await optRes.json() as PublicKeyCredentialRequestOptionsJSON;

      const response = await startAuthentication({ optionsJSON: options });

      const verRes = await fetch("/api/auth/passkey/authenticate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response }),
      });
      const vd = await verRes.json() as { ok?: boolean; error?: string };
      if (!verRes.ok) throw new Error(vd.error ?? "Authentication failed.");

      onSuccess?.();
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.includes("cancelled") && !msg.includes("AbortError") && !msg.includes("NotAllowedError")) {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={authenticate}
        disabled={loading}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-panel px-4 py-2.5 text-sm font-medium transition hover:bg-panel2 disabled:opacity-50",
          className,
        )}
      >
        <KeyRound className="h-4 w-4 shrink-0" />
        {loading ? "Waiting for passkey…" : "Sign in with Passkey"}
      </button>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
