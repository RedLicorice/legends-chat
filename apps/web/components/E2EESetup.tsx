"use client";

import { useState } from "react";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import {
  exportIdentityBackup,
  exportPublicKey,
  getOrCreateIdentityKeyPair,
  importIdentityBackup,
} from "@/lib/e2ee";

interface E2EESetupProps {
  userId: string;
  hasPermanentAccount: boolean;
  existingBackup?: string | null;
  onReady: (kp: CryptoKeyPair) => void;
  onSkip?: () => void;
}

export function E2EESetup({ userId, hasPermanentAccount, existingBackup, onReady, onSkip }: E2EESetupProps) {
  const [step, setStep] = useState<"choose" | "backup" | "restore" | "working">("choose");
  const [passphrase, setPassphrase] = useState("");
  const [passphrase2, setPassphrase2] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function generateAndRegister(withBackup: boolean) {
    setLoading(true);
    setError("");
    try {
      const kp = await getOrCreateIdentityKeyPair();
      const pubB64 = await exportPublicKey(kp.publicKey);
      let backup: string | undefined;
      if (withBackup && passphrase) {
        backup = await exportIdentityBackup(kp, passphrase);
      }
      const res = await fetch("/api/user/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityPublicKey: pubB64, backup }),
      });
      if (!res.ok) throw new Error("Failed to register key");
      onReady(kp);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  async function restoreFromBackup() {
    if (!existingBackup) { setError("No backup found on server"); return; }
    setLoading(true);
    setError("");
    try {
      const kp = await importIdentityBackup(existingBackup, passphrase);
      const pubB64 = await exportPublicKey(kp.publicKey);
      const res = await fetch("/api/user/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityPublicKey: pubB64 }),
      });
      if (!res.ok) throw new Error("Failed to register key");
      onReady(kp);
    } catch {
      setError("Wrong passphrase or invalid backup");
    } finally {
      setLoading(false);
    }
  }

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
            <button
              type="button"
              onClick={() => hasPermanentAccount ? setStep("backup") : generateAndRegister(false)}
              disabled={loading}
              className="w-full rounded-xl border border-border bg-panel2 px-4 py-3 text-left hover:bg-panel transition"
            >
              <div className="flex items-start gap-3">
                <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-accent2" />
                <div>
                  <div className="text-sm font-medium">
                    {hasPermanentAccount ? "Generate new key with passphrase backup" : "Generate new key"}
                  </div>
                  <div className="text-xs text-muted mt-0.5">
                    {hasPermanentAccount
                      ? "Key stored in this browser + encrypted backup on server"
                      : "Key stored in this browser only"}
                  </div>
                </div>
              </div>
            </button>

            {existingBackup && (
              <button
                type="button"
                onClick={() => setStep("restore")}
                disabled={loading}
                className="w-full rounded-xl border border-border bg-panel2 px-4 py-3 text-left hover:bg-panel transition"
              >
                <div className="text-sm font-medium">Restore from passphrase backup</div>
                <div className="text-xs text-muted mt-0.5">Use your passphrase to restore your existing key</div>
              </button>
            )}

            {onSkip && (
              <button type="button" onClick={onSkip} className="w-full text-center text-xs text-muted hover:text-text py-1">
                Skip for now (read-only)
              </button>
            )}
          </div>
        )}

        {step === "backup" && (
          <div className="space-y-3">
            <p className="text-sm text-muted">Choose a passphrase to encrypt your key backup. You&apos;ll need this to restore your key on a new device.</p>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Passphrase"
              className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none"
            />
            <input
              type="password"
              value={passphrase2}
              onChange={(e) => setPassphrase2(e.target.value)}
              placeholder="Confirm passphrase"
              className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none"
            />
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep("choose")} className="flex-1 rounded-lg border border-border px-3 py-2 text-sm hover:bg-panel2 transition">
                Back
              </button>
              <button
                type="button"
                onClick={() => {
                  if (passphrase !== passphrase2) { setError("Passphrases don't match"); return; }
                  if (passphrase.length < 8) { setError("Passphrase too short (min 8 chars)"); return; }
                  void generateAndRegister(true);
                }}
                disabled={loading || !passphrase}
                className="flex-1 rounded-lg bg-accent px-3 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 transition"
              >
                {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Generate & backup
              </button>
            </div>
          </div>
        )}

        {step === "restore" && (
          <div className="space-y-3">
            <p className="text-sm text-muted">Enter your passphrase to restore your encryption key from backup.</p>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Passphrase"
              className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none"
            />
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep("choose")} className="flex-1 rounded-lg border border-border px-3 py-2 text-sm hover:bg-panel2 transition">
                Back
              </button>
              <button
                type="button"
                onClick={() => void restoreFromBackup()}
                disabled={loading || !passphrase}
                className="flex-1 rounded-lg bg-accent px-3 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 transition"
              >
                {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Restore key
              </button>
            </div>
          </div>
        )}

        {step === "working" && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
          </div>
        )}
      </div>
    </div>
  );
}
