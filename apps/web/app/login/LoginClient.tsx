"use client";
import { apiFetch } from "@/lib/fetch";
import { clearSessionId } from "@/lib/e2ee-session";

import { useState, useEffect, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { PasskeyAuthButton } from "@/components/PasskeyAuthButton";
import { InstallButton } from "@/components/InstallButton";

export function LoginClient() {
  const router = useRouter();
  const [tab, setTab] = useState<"passkey" | "email" | "telegram">("passkey");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  // If already signed in (e.g. user swiped back to /login after authenticating),
  // bounce to the app — /login should never be a reachable back-stack screen for
  // a logged-in user. `replace` so it doesn't add another history entry.
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/me")
      .then((r) => {
        if (!cancelled && r.ok) router.replace("/");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    apiFetch("/api/register-config")
      .then((r) => r.json())
      .then((d: { registrationMode: string; botUsername: string | null }) => {
        setEmailEnabled(d.registrationMode === "open");
        setBotUsername(d.botUsername ?? null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("error");
    if (!code) return;
    const messages: Record<string, string> = {
      "missing-token": "Link is missing a token. Request a new sign-in link.",
      "invalid-token": "Sign-in link is invalid or has expired. Request a new one.",
      "wrong-token-type": "This link is for an unfinished registration. Open it from the original device.",
      "user-not-found": "Account no longer exists. Contact an admin.",
    };
    setNotice(messages[code] ?? "Sign-in failed. Try again.");
    url.searchParams.delete("error");
    window.history.replaceState(null, "", url.pathname + (url.search ? url.search : ""));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
          totpCode: totpCode.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Server signals a confirmed-TOTP account needs its 6-digit code.
        if (data.totpRequired) setTotpRequired(true);
        setError(data.error ?? "Login failed.");
        return;
      }
      clearSessionId();
      router.replace("/");
    } catch {
      setError("Network error. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mb-6 text-sm text-muted">Welcome back.</p>

        {notice && (
          <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
            {notice}
          </div>
        )}

        {/* Tab switcher */}
        <div className="mb-6 flex rounded-lg border border-border bg-panel p-1">
          <TabBtn active={tab === "passkey"} onClick={() => setTab("passkey")}>Passkey</TabBtn>
          {emailEnabled && <TabBtn active={tab === "email"} onClick={() => setTab("email")}>Email</TabBtn>}
          <TabBtn active={tab === "telegram"} onClick={() => setTab("telegram")}>Telegram</TabBtn>
        </div>

        {tab === "telegram" ? (
          <div className="rounded-xl border border-border bg-panel p-5 text-sm text-muted space-y-3">
            {botUsername ? (
              <>
                <a
                  href={`https://t.me/${botUsername}?start=login`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex w-full items-center justify-center rounded-xl bg-accent py-2.5 text-sm font-medium text-white hover:opacity-90"
                >
                  Open @{botUsername} in Telegram
                </a>
                <p className="text-xs text-center">Tap the button above, send <code className="rounded bg-panel2 px-1 text-accent">/start</code>, then open the link the bot replies with.</p>
              </>
            ) : (
              <>
                <p>Open Telegram and message the community bot.</p>
                <p>Send <code className="rounded bg-panel2 px-1 text-accent">/start</code> and tap the link it sends back.</p>
              </>
            )}
            <p className="text-xs">No invite code yet? Ask a member to generate one for you.</p>
          </div>
        ) : tab === "passkey" ? (
          <div className="space-y-3">
            <PasskeyAuthButton onSuccess={() => { clearSessionId(); router.replace("/"); }} />
            <p className="text-center text-xs text-muted">
              Use a registered passkey to sign in instantly.
            </p>
          </div>
        ) : emailEnabled ? (
          <form onSubmit={onSubmit} className="space-y-4">
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
                placeholder="••••••••"
                className="w-full rounded-xl border border-border bg-panel px-4 py-2.5 text-sm outline-none focus:border-accent placeholder:text-muted"
              />
            </div>
            {totpRequired && (
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Authenticator code</label>
                <input
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  className="w-full rounded-xl border border-border bg-panel px-4 py-2.5 text-sm tracking-widest outline-none focus:border-accent placeholder:text-muted"
                />
              </div>
            )}
            {error && <p className="text-sm text-danger">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading && <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        ) : null}

        {emailEnabled && (
          <p className="mt-4 text-center text-sm text-muted">
            No account?{" "}
            <Link href="/register" className="text-accent hover:underline">Create one</Link>
          </p>
        )}
        {/* Install renders null when already standalone / unsupported. Lets a
            visitor install the app first, then log in or register from it. */}
        <div className="mt-6">
          <InstallButton />
        </div>
        <p className="mt-6 text-center text-xs text-muted/60">
          <Link href="/docs/whitepaper" className="hover:text-muted underline underline-offset-2">
            Privacy &amp; Security Whitepaper
          </Link>
        </p>
      </div>
    </main>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${
        active ? "bg-accent text-white" : "text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
