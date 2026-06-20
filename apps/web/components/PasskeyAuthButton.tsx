"use client";
import { apiFetch } from "@/lib/fetch";

import { useCallback, useRef, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { cn } from "@/lib/cn";

interface Props {
  onSuccess?: () => void;
  className?: string;
}

// Authentication options stay valid for 5 minutes on the server (Redis TTL).
// Prefetch on first user intent (pointer/focus) so the click → OS passkey
// sheet gap is dominated by WebAuthn, not by a 200-500ms round-trip. Avoids
// burning a global Redis challenge slot on every page load when the button
// is never engaged.
const PREFETCH_STALE_MS = 4 * 60 * 1000; // 4 min — refresh before the 5 min TTL

export function PasskeyAuthButton({ onSuccess, className }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefetched = useRef<{ at: number; opts: PublicKeyCredentialRequestOptionsJSON } | null>(null);
  const prefetchInFlight = useRef(false);
  // While authenticating, prefetch MUST NOT fire: each GET rotates the
  // per-session cookie + Redis challenge. If the button refocuses (e.g. when
  // the native passkey sheet closes) and prefetch overwrites the cookie
  // before the POST lands, the server's stored challenge no longer matches
  // the WebAuthn-signed one and verification fails. The user then has to
  // retry, sometimes multiple times, until the timing aligns.
  const authBusy = useRef(false);

  const prefetch = useCallback(() => {
    if (authBusy.current) return;
    if (prefetchInFlight.current) return;
    const fresh = prefetched.current && Date.now() - prefetched.current.at < PREFETCH_STALE_MS;
    if (fresh) return;
    prefetchInFlight.current = true;
    void (async () => {
      try {
        const r = await apiFetch("/api/auth/passkey/authenticate");
        if (!r.ok) return;
        const opts = (await r.json()) as PublicKeyCredentialRequestOptionsJSON;
        prefetched.current = { at: Date.now(), opts };
      } catch {
        // Best-effort; click path falls back to live fetch.
      } finally {
        prefetchInFlight.current = false;
      }
    })();
  }, []);

  async function authenticate() {
    setError(null);
    setLoading(true);
    authBusy.current = true;
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
      authBusy.current = false;
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={authenticate}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        disabled={loading}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-panel px-4 py-2.5 text-sm font-medium transition hover:bg-panel2 disabled:opacity-50",
          className,
        )}
      >
        {loading
          ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          : <KeyRound className="h-4 w-4 shrink-0" />}
        {loading ? "Waiting for passkey…" : "Sign in with Passkey"}
      </button>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
