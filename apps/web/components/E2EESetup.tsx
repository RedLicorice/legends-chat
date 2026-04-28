"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Fingerprint, KeyRound, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/fetch";
import {
  clearAllSenderKeys,
  exportIdentityBackupWithPrf,
  exportPublicKey,
  generateNewIdentityKeyPair,
  getPrfCredentialName,
  importIdentityBackupWithPrf,
} from "@/lib/e2ee";

interface Passkey { id: string; name: string; }

interface E2EESetupProps {
  userId: string;
  hasPermanentAccount: boolean;
  existingBackup?: string | null;
  onReady: (kp: CryptoKeyPair) => void;
  onSkip?: () => void;
}

export function E2EESetup({ hasPermanentAccount, existingBackup, onReady, onSkip }: E2EESetupProps) {
  const [step, setStep] = useState<"choose" | "passkey-select" | "restore">("choose");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);

  useEffect(() => {
    if (!hasPermanentAccount) return;
    apiFetch("/api/user/passkeys")
      .then((r) => r.json() as Promise<{ passkeys?: Passkey[] }>)
      .then((d) => setPasskeys(d.passkeys ?? []))
      .catch(() => {});
  }, [hasPermanentAccount]);

  async function generateWithoutBackup() {
    setLoading(true);
    setError("");
    try {
      const kp = await generateNewIdentityKeyPair();
      const pubB64 = await exportPublicKey(kp.publicKey);
      const res = await apiFetch("/api/user/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityPublicKey: pubB64 }),
      });
      if (!res.ok) throw new Error("Failed to register key");
      await clearAllSenderKeys();
      onReady(kp);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  async function generateAndRegisterWithPrf(credentialId: string, credentialName: string) {
    setLoading(true);
    setError("");
    try {
      const kp = await generateNewIdentityKeyPair();
      const pubB64 = await exportPublicKey(kp.publicKey);
      const backup = await exportIdentityBackupWithPrf(kp, credentialId, credentialName);
      const res = await apiFetch("/api/user/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityPublicKey: pubB64, backup }),
      });
      if (!res.ok) throw new Error("Failed to register key");
      await clearAllSenderKeys();
      onReady(kp);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed";
      setError(msg.includes("PRF") ? "This passkey doesn't support secure backup. Try a different passkey." : msg);
    } finally {
      setLoading(false);
    }
  }

  async function restoreFromBackup() {
    if (!existingBackup) { setError("No backup found on server"); return; }
    setLoading(true);
    setError("");
    try {
      const kp = await importIdentityBackupWithPrf(existingBackup);
      const pubB64 = await exportPublicKey(kp.publicKey);
      const res = await apiFetch("/api/user/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityPublicKey: pubB64, backup: existingBackup }),
      });
      if (!res.ok) throw new Error("Failed to register key");
      onReady(kp);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.startsWith("Failed") ? msg : "Could not unlock — passkey not available on this device");
    } finally {
      setLoading(false);
    }
  }

  const prfCredentialName = existingBackup ? getPrfCredentialName(existingBackup) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-panel shadow-2xl p-6">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/20">
            <KeyRound className="h-5 w-5 text-accent" />
          </div>
          <div>
            <h2 className="font-semibold">Set up end-to-end encryption</h2>
            <p className="text-xs text-muted">This topic requires E2EE. Set up your key to participate.</p>
          </div>
        </div>

        {step === "choose" && (
          <div className="space-y-3">
            {existingBackup && (
              <button
                type="button"
                onClick={() => setStep("restore")}
                disabled={loading}
                className="w-full rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-left hover:bg-accent/20 transition"
              >
                <div className="flex items-start gap-3">
                  <Fingerprint className="h-4 w-4 mt-0.5 shrink-0 text-accent" />
                  <div>
                    <div className="text-sm font-medium">
                      Restore with passkey{prfCredentialName ? ` "${prfCredentialName}"` : ""}
                    </div>
                    <div className="text-xs text-muted mt-0.5">Requires the same passkey on this device</div>
                  </div>
                </div>
              </button>
            )}

            {hasPermanentAccount && passkeys.length > 0 && (
              <button
                type="button"
                onClick={() => setStep("passkey-select")}
                disabled={loading}
                className="w-full rounded-xl border border-border bg-panel2 px-4 py-3 text-left hover:bg-panel transition"
              >
                <div className="flex items-start gap-3">
                  <Fingerprint className="h-4 w-4 mt-0.5 shrink-0 text-accent" />
                  <div>
                    <div className="text-sm font-medium">Generate new key — secured by passkey</div>
                    <div className="text-xs text-muted mt-0.5">Key backup encrypted with your passkey — restoreable on any device where that passkey is available</div>
                  </div>
                </div>
              </button>
            )}

            {hasPermanentAccount && passkeys.length === 0 && (
              <div className="rounded-xl border border-border bg-panel2 px-4 py-3 flex items-start gap-3">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-accent2" />
                <div>
                  <p className="text-sm font-medium">No passkeys registered</p>
                  <p className="text-xs text-muted mt-0.5">Register a passkey in account settings first to enable E2EE with secure key backup.</p>
                </div>
              </div>
            )}

            {!hasPermanentAccount && (
              <button
                type="button"
                onClick={() => void generateWithoutBackup()}
                disabled={loading}
                className="w-full rounded-xl border border-border bg-panel2 px-4 py-3 text-left hover:bg-panel transition"
              >
                <div className="flex items-start gap-3">
                  <KeyRound className="h-4 w-4 mt-0.5 shrink-0 text-accent" />
                  <div>
                    <div className="text-sm font-medium">Generate new key</div>
                    <div className="text-xs text-muted mt-0.5">Stored in this browser only — not recoverable on other devices</div>
                  </div>
                </div>
              </button>
            )}

            {onSkip && (
              <button type="button" onClick={onSkip} className="w-full text-center text-xs text-muted hover:text-text py-1">
                Skip for now (read-only)
              </button>
            )}
          </div>
        )}

        {step === "passkey-select" && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              Choose which passkey will protect your E2EE key backup.{" "}
              <strong className="text-text">You&apos;ll need this same passkey to access messages on other devices.</strong>
            </p>
            <div className="space-y-2">
              {passkeys.map((pk) => (
                <button
                  key={pk.id}
                  type="button"
                  onClick={() => void generateAndRegisterWithPrf(pk.id, pk.name)}
                  disabled={loading}
                  className="w-full rounded-xl border border-border bg-panel2 px-4 py-3 text-left hover:bg-panel transition flex items-center gap-3"
                >
                  <Fingerprint className="h-4 w-4 shrink-0 text-accent" />
                  <span className="flex-1 text-sm font-medium">{pk.name}</span>
                  {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />}
                </button>
              ))}
            </div>
            {error && <p className="text-xs text-danger">{error}</p>}
            <button type="button" onClick={() => { setStep("choose"); setError(""); }} className="w-full rounded-lg border border-border px-3 py-2 text-sm hover:bg-panel2 transition">
              Back
            </button>
          </div>
        )}

        {step === "restore" && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              Tap your{prfCredentialName ? <> &ldquo;<strong>{prfCredentialName}</strong>&rdquo;</> : " registered"} passkey to restore your encryption key.
            </p>
            <p className="text-xs text-muted">This passkey must be registered and available on this device.</p>
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={() => { setStep("choose"); setError(""); }} className="flex-1 rounded-lg border border-border px-3 py-2 text-sm hover:bg-panel2 transition">Back</button>
              <button
                type="button"
                onClick={() => void restoreFromBackup()}
                disabled={loading}
                className="flex-1 rounded-lg bg-accent px-3 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 transition"
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Fingerprint className="h-3.5 w-3.5" />}
                Unlock with passkey
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
