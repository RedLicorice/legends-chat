"use client";

import { useState } from "react";
import { Mail, X } from "lucide-react";

export function EmailLinkBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [step, setStep] = useState<"prompt" | "enter-email" | "enter-otp" | "done">("prompt");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dismiss() {
    setDismissed(true);
    await fetch("/api/user/email-link", { method: "DELETE" });
  }

  async function sendOtp() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/user/email-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) { setError(data.error ?? "Error"); return; }
      setStep("enter-otp");
    } catch { setError("Network error."); }
    finally { setLoading(false); }
  }

  async function verifyOtp() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/user/email-link/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ otp }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) { setError(data.error ?? "Error"); return; }
      setStep("done");
    } catch { setError("Network error."); }
    finally { setLoading(false); }
  }

  if (dismissed) return null;

  if (step === "done") {
    return (
      <div className="flex items-center gap-3 border-b border-border bg-green-900/20 px-4 py-2 text-sm text-green-400">
        <Mail className="h-4 w-4 shrink-0" />
        Email linked successfully.
        <button onClick={() => setDismissed(true)} className="ml-auto"><X className="h-4 w-4" /></button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-panel2 px-4 py-2 text-sm">
      <Mail className="h-4 w-4 shrink-0 text-accent" />
      {step === "prompt" && (
        <>
          <span className="flex-1 text-muted">Link an email address for account recovery.</span>
          <button onClick={() => setStep("enter-email")} className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90">
            Link email
          </button>
          <button onClick={dismiss} className="text-muted hover:text-foreground" title="Dismiss"><X className="h-4 w-4" /></button>
        </>
      )}
      {step === "enter-email" && (
        <>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="flex-1 rounded-lg border border-border bg-panel px-3 py-1 text-sm outline-none focus:border-accent min-w-0"
          />
          {error && <span className="text-xs text-danger">{error}</span>}
          <button onClick={sendOtp} disabled={loading || !email} className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50">
            {loading ? "Sending…" : "Send code"}
          </button>
          <button onClick={() => setStep("prompt")} className="text-muted hover:text-foreground"><X className="h-4 w-4" /></button>
        </>
      )}
      {step === "enter-otp" && (
        <>
          <span className="text-muted">Enter the 6-digit code sent to {email}</span>
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            className="w-24 rounded-lg border border-border bg-panel px-3 py-1 text-sm font-mono outline-none focus:border-accent"
          />
          {error && <span className="text-xs text-danger">{error}</span>}
          <button onClick={verifyOtp} disabled={loading || otp.length !== 6} className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50">
            {loading ? "Verifying…" : "Verify"}
          </button>
        </>
      )}
    </div>
  );
}
