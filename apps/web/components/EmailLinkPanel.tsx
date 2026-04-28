"use client";
import { apiFetch } from "@/lib/fetch";

import { useEffect, useState } from "react";
import { Mail, CheckCircle } from "lucide-react";

export function EmailLinkPanel() {
  const [linkedEmail, setLinkedEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [emailInput, setEmailInput] = useState("");
  const [otpInput, setOtpInput] = useState("");
  const [step, setStep] = useState<"idle" | "otp">("idle");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/user/profile")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.email) setLinkedEmail(d.email); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function sendOtp() {
    setBusy(true); setError(null);
    try {
      const res = await apiFetch("/api/user/email-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: emailInput.trim().toLowerCase() }),
      });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? "Failed to send code.");
      setStep("otp");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function verifyOtp() {
    setBusy(true); setError(null);
    try {
      const res = await apiFetch("/api/user/email-link/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ otp: otpInput.trim() }),
      });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? "Invalid code.");
      setLinkedEmail(emailInput.trim().toLowerCase());
      setSuccess(true);
      setStep("idle");
      setEmailInput("");
      setOtpInput("");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (loading) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">Email</h2>
        {success && <CheckCircle className="h-4 w-4 text-green-500" />}
      </div>

      {linkedEmail ? (
        <>
          <div className="flex items-center gap-2 rounded-xl border border-border bg-panel2 px-4 py-3">
            <Mail className="h-4 w-4 shrink-0 text-accent" />
            <span className="text-sm">{linkedEmail}</span>
          </div>
          <p className="text-xs text-muted">Email is linked. You can use it to sign in.</p>
        </>
      ) : step === "idle" ? (
        <>
          <div className="flex gap-2">
            <input
              type="email"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              placeholder="you@example.com"
              className="min-w-0 flex-1 rounded-xl border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={sendOtp}
              disabled={busy || !emailInput.trim()}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "…" : "Link"}
            </button>
          </div>
          <p className="text-xs text-muted">Link an email address to sign in with a password.</p>
        </>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted">Code sent to {emailInput}.</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={otpInput}
              onChange={(e) => setOtpInput(e.target.value)}
              placeholder="6-digit code"
              maxLength={6}
              className="min-w-0 flex-1 rounded-xl border border-border bg-panel2 px-3 py-2 text-sm font-mono tracking-widest outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={verifyOtp}
              disabled={busy || otpInput.length < 6}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "…" : "Verify"}
            </button>
          </div>
          <button type="button" onClick={() => { setStep("idle"); setError(null); }} className="text-xs text-muted hover:text-text">
            ← Back
          </button>
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
