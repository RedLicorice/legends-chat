"use client";
import { apiFetch } from "@/lib/fetch";
import { clearSessionId } from "@/lib/e2ee-session";

import { useState, useEffect, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Step = "loading" | "invite" | "form" | "unavailable";

export default function RegisterPage() {
  const router = useRouter();

  const [step, setStep] = useState<Step>("loading");
  const [invitesRequired, setInvitesRequired] = useState(false);

  // Invite step state
  const [inviteCode, setInviteCode] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);

  // Locked-in code (after passing invite step)
  const [lockedCode, setLockedCode] = useState<string | null>(null);

  // Form step state
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formLoading, setFormLoading] = useState(false);

  useEffect(() => {
    apiFetch("/api/register-config")
      .then((r) => r.json())
      .then((data: { invitesRequired: boolean; registrationMode: string }) => {
        if (data.registrationMode !== "open") {
          setStep("unavailable");
          return;
        }
        setInvitesRequired(data.invitesRequired);
        setStep(data.invitesRequired ? "invite" : "form");
      })
      .catch(() => {
        setStep("unavailable");
      });
  }, []);

  async function onCheckInvite(e: FormEvent) {
    e.preventDefault();
    setInviteError(null);
    const code = inviteCode.trim().toUpperCase();
    if (!code) {
      setInviteError("Please enter an invite code.");
      return;
    }
    setInviteLoading(true);
    try {
      const res = await apiFetch(`/api/invite-check?code=${encodeURIComponent(code)}`);
      const data = await res.json() as { valid: boolean; error?: string };
      if (!data.valid) {
        setInviteError(data.error ?? "Invalid or expired invite code.");
        return;
      }
      setLockedCode(code);
      setStep("form");
    } catch {
      setInviteError("Network error. Try again.");
    } finally {
      setInviteLoading(false);
    }
  }

  function onClearLockedCode() {
    setLockedCode(null);
    setInviteCode(lockedCode ?? "");
    setStep("invite");
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormLoading(true);
    try {
      const res = await apiFetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim(),
          email: email.trim().toLowerCase(),
          password,
          inviteCode: lockedCode ?? undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error ?? "Registration failed.");
        return;
      }
      clearSessionId();
      router.push("/");
    } catch {
      setFormError("Network error. Try again.");
    } finally {
      setFormLoading(false);
    }
  }

  if (step === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm flex flex-col items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="text-sm text-muted">Loading…</p>
        </div>
      </main>
    );
  }

  if (step === "unavailable") {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <h1 className="mb-1 text-2xl font-semibold tracking-tight">Registration unavailable</h1>
          <p className="mb-6 text-sm text-muted">Registration is not available. Contact an admin.</p>
          <Link href="/login" className="text-sm text-accent hover:underline">← Back to sign in</Link>
        </div>
      </main>
    );
  }

  if (step === "invite") {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-6">
            <Link href="/login" className="text-sm text-muted hover:text-accent">← Back to sign in</Link>
          </div>

          <h1 className="mb-1 text-2xl font-semibold tracking-tight">Enter invite code</h1>
          <p className="mb-6 text-sm text-muted">An invite code is required to create an account.</p>

          <form onSubmit={onCheckInvite} className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Invite code</label>
              <input
                required
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="LGND#XXXXXX"
                autoFocus
                className="w-full rounded-xl border border-border bg-panel px-4 py-2.5 text-sm outline-none focus:border-accent placeholder:text-muted font-mono"
              />
            </div>

            {inviteError && <p className="text-sm text-danger">{inviteError}</p>}

            <button
              type="submit"
              disabled={inviteLoading}
              className="w-full rounded-xl bg-accent py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {inviteLoading ? "Checking…" : "Check code"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  // step === "form"
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          {invitesRequired ? (
            <button
              type="button"
              onClick={onClearLockedCode}
              className="text-sm text-muted hover:text-accent"
            >
              ← Back
            </button>
          ) : (
            <Link href="/login" className="text-sm text-muted hover:text-accent">← Back to sign in</Link>
          )}
        </div>

        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Create account</h1>
        <p className="mb-6 text-sm text-muted">Join with email and password.</p>

        <form onSubmit={onSubmit} className="space-y-4">
          {invitesRequired && lockedCode && (
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Invite code</label>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={lockedCode}
                  className="flex-1 rounded-xl border border-border bg-panel px-4 py-2.5 text-sm outline-none font-mono text-muted cursor-default"
                />
                <button
                  type="button"
                  onClick={onClearLockedCode}
                  title="Change invite code"
                  className="flex-shrink-0 rounded-lg border border-border bg-panel px-3 py-2.5 text-sm text-muted hover:text-danger hover:border-danger transition-colors"
                >
                  ×
                </button>
              </div>
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Display name</label>
            <input
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={64}
              placeholder="Your name"
              className="w-full rounded-xl border border-border bg-panel px-4 py-2.5 text-sm outline-none focus:border-accent placeholder:text-muted"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Email</label>
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-xl border border-border bg-panel px-4 py-2.5 text-sm outline-none focus:border-accent placeholder:text-muted"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Password</label>
            <input
              required
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              placeholder="At least 8 characters"
              className="w-full rounded-xl border border-border bg-panel px-4 py-2.5 text-sm outline-none focus:border-accent placeholder:text-muted"
            />
          </div>

          {formError && <p className="text-sm text-danger">{formError}</p>}

          <button
            type="submit"
            disabled={formLoading}
            className="w-full rounded-xl bg-accent py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {formLoading ? "Creating account…" : "Create account"}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-muted">
          Already have an account?{" "}
          <Link href="/login" className="text-accent hover:underline">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
