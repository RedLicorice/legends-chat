"use client";
import { apiFetch } from "@/lib/fetch";

import { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { cn } from "@/lib/cn";

interface Props {
  onSuccess?: () => void;
  className?: string;
}

// Authentication options stay valid for 5 minutes on the server (Redis TTL).
// Prefetch when the button mounts so the click → OS passkey sheet gap is
// dominated by WebAuthn, not by a 200-500ms round-trip to /api/auth/passkey
// — the latter was the entire user-perceived delay on mobile.
const PREFETCH_STALE_MS = 4 * 60 * 1000; // 4 min — refresh before the 5 min TTL

export function PasskeyAuthButton({ onSuccess, className }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefetched = useRef<{ at: number; opts: PublicKeyCredentialRequestOptionsJSON } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch("/api/auth/passkey/authenticate");
        if (!r.ok || cancelled) return;
        const opts = (await r.json()) as PublicKeyCredentialRequestOptionsJSON;
        if (!cancelled) prefetched.current = { at: Date.now(), opts };
      } catch {
        // Best-effort prefetch; click path will fall back to live fetch.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function authenticate() {
    setError(null);
    setLoading(true);
    try {
      let options: PublicKeyCredentialRequestOptionsJSON;
      const cached = prefetched.current;
      if (cached && Date.now() - cached.at < PREFETCH_STALE_MS) {
        options = cached.opts;
        // Consume once — server invalidates on POST, refetch for any retry.
        prefetched.current = null;
      } else {
        const optRes = await apiFetch("/api/auth/passkey/authenticate");
        if (!optRes.ok) throw new Error("Failed to get authentication options.");
        options = (await optRes.json()) as PublicKeyCredentialRequestOptionsJSON;
      }

      const response = await startAuthentication({ optionsJSON: options });

      const verRes = await apiFetch("/api/auth/passkey/authenticate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response }),
      });
      const vd = await verRes.json() as { ok?: boolean; error?: string };
      if (!verRes.ok) throw new Error(vd.error ?? "Authentication failed.");

      onSuccess?.();
    } catch (e) {
      const err = e as Error;
      const msg = err.message ?? "";
      const isCancel = msg.includes("cancelled") || err.name === "AbortError" || msg.includes("NotAllowedError");
      if (!isCancel) {
        const isBackup = msg.toLowerCase().includes("backup");
        setError(
          isBackup
            ? "Your authenticator doesn't support cloud backup. Register it via Settings → Security using \"Use external authenticator\"."
            : msg,
        );
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
