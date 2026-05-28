"use client";
import { apiFetch } from "@/lib/fetch";
import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { KeyRound } from "lucide-react";
import { startRegistration } from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { openInBrowser } from "@/lib/platform-detect";

type State = "loading" | "authenticated" | "existing" | "new" | "invalid";

interface UserView {
  displayName: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
}

interface PendingView {
  telegramUsername: string;
  inviteCode: string | null;
}

interface Settings {
  requirePasskeyAtRegistration: boolean;
  magicLinkLoginDisabled: boolean;
}

export function LandingClient() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";

  const [state, setState] = useState<State>("loading");
  const [user, setUser] = useState<UserView | null>(null);
  const [pending, setPending] = useState<PendingView | null>(null);
  const [settings, setSettings] = useState<Settings>({ requirePasskeyAtRegistration: false, magicLinkLoginDisabled: false });
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iosInstructions, setIosInstructions] = useState(false);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    apiFetch(`/api/auth/landing-info?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((data) => {
        setState(data.state);
        if (data.user) setUser(data.user);
        if (data.pending) {
          setPending(data.pending);
          setDisplayName(data.pending.telegramUsername || "");
        }
        if (data.settings) setSettings(data.settings);

        // Desktop existing users: skip landing entirely. Mobile users still see
        // the profile card so they can deliberately leave the in-app browser /
        // hit the "Open app" platform-detection flow.
        // Desktop authenticated user: nothing to do here, just open the app.
        // Token is unused; cookies already present in this browser.
        const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
        const isMobile = /android|iphone|ipad|ipod/i.test(ua);
        if (data.state === "authenticated" && !isMobile) {
          window.location.replace("/");
          return;
        }
        // Desktop existing user: redirect straight to /auth/callback?token=X.
        // /auth/callback consumes the token AND sets cookies in this same
        // browser (so the home page sees a valid session). The /api/auth/
        // telegram-login POST is for same-browser flows that don't want to
        // navigate — currently unused by the happy path because cookies set
        // by an in-app WebView never transfer to the user's real browser.
        if (
          data.state === "existing" &&
          !isMobile &&
          !data.settings?.magicLinkLoginDisabled
        ) {
          window.location.replace(`/auth/callback?token=${encodeURIComponent(token)}`);
        }
      })
      .catch(() => setState("invalid"));
  }, [token]);

  // Build the URL the user lands on AFTER leaving this page.
  // - Token still pending consumption (existing user OR new user we just
  //   registered): /auth/callback?token=X (sets cookies in target browser,
  //   then bounces to /).
  // - Anyone else: just / (already authenticated, or no consumable token).
  function buildOpenPath(): string {
    const tokenStillPending =
      (state === "existing" || state === "new") &&
      !settings.magicLinkLoginDisabled &&
      token;
    if (tokenStillPending) {
      return `/auth/callback?token=${encodeURIComponent(token)}`;
    }
    return "/";
  }

  function openApp() {
    if (opening) return;
    setOpening(true);
    const target = buildOpenPath();
    const result = openInBrowser(target);
    if (result.kind === "android") {
      window.location.href = result.intentUrl;
    } else if (result.kind === "ios-instructions") {
      setIosInstructions(true);
    } else {
      window.location.replace(target);
    }
  }

  async function registerSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const regRes = await apiFetch("/api/auth/telegram-register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, displayName: displayName.trim() }),
      });
      const regData = await regRes.json() as {
        ok?: boolean;
        requirePasskey?: boolean;
        userId?: string;
        passkeyOptions?: PublicKeyCredentialCreationOptionsJSON;
        error?: string;
      };
      if (!regRes.ok) {
        setError(regData.error ?? "Registration failed.");
        return;
      }
      if (regData.requirePasskey && regData.userId && regData.passkeyOptions) {
        let credential: RegistrationResponseJSON;
        try {
          credential = await startRegistration({ optionsJSON: regData.passkeyOptions });
        } catch (e) {
          const msg = (e as Error).message ?? "";
          const isBackup = msg.toLowerCase().includes("backup");
          setError(isBackup
            ? "Your authenticator doesn't support cloud backup. Try a different one."
            : "Passkey registration was cancelled or failed. Refresh the link from the bot to try again.");
          return;
        }
        const pkRes = await apiFetch("/api/auth/telegram-register/passkey", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: regData.userId, passkeyResponse: credential }),
        });
        if (!pkRes.ok) {
          const pkData = await pkRes.json().catch(() => ({}));
          setError(pkData.error ?? "Passkey verification failed.");
          return;
        }
      }
      openApp();
    } finally {
      setSubmitting(false);
    }
  }

  if (state === "loading") {
    return <Center><Spinner /></Center>;
  }

  if (state === "invalid") {
    const headline = token ? "Link expired" : "Invalid link";
    const body = token
      ? "This sign-in link is invalid or has expired."
      : "This page needs a sign-in link from the bot.";
    return (
      <Center>
        <div className="max-w-sm space-y-2 text-center">
          <h1 className="text-lg font-semibold">{headline}</h1>
          <p className="text-sm text-muted">{body} Send <code className="rounded bg-panel2 px-1 text-accent">/start</code> to the bot to get a new one.</p>
        </div>
      </Center>
    );
  }

  if (iosInstructions) {
    return (
      <Center>
        <div className="max-w-sm space-y-3 text-center">
          <h1 className="text-lg font-semibold">Open in Safari</h1>
          <p className="text-sm text-muted">Tap <strong>···</strong> (top right), then <strong>Open in Safari</strong>.</p>
          <a href="/" className="inline-block rounded-xl bg-accent px-6 py-3 text-sm font-semibold text-white">Open the app</a>
        </div>
      </Center>
    );
  }

  if (state === "authenticated" || state === "existing") {
    // Magic link on + existing user: consume token to get session.
    // Magic link off OR already authenticated: skip session step, just open the app.
    return (
      <ProfileCard
        user={user}
        buttonLabel={opening ? "Opening…" : "Open app"}
        onAction={openApp}
        disabled={opening}
        error={error}
      />
    );
  }

  // state === "new"
  return (
    <Center>
      <div className="w-full max-w-sm space-y-5 p-6">
        <div>
          <h1 className="text-xl font-semibold">Create your account</h1>
          <p className="mt-1 text-sm text-muted">Confirm your details to continue.</p>
        </div>

        <form onSubmit={registerSubmit} className="space-y-4">
          {pending?.inviteCode && (
            <Field label="Invite code">
              <ReadOnlyInput value={pending.inviteCode} mono />
            </Field>
          )}
          <Field label="Telegram username">
            <ReadOnlyInput value={pending?.telegramUsername ? `@${pending.telegramUsername}` : "(no username)"} />
          </Field>
          <Field label="Display name">
            <input
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              minLength={2}
              maxLength={64}
              placeholder="Your name"
              className="w-full rounded-xl border border-border bg-panel px-4 py-2.5 text-sm outline-none focus:border-accent placeholder:text-muted"
            />
          </Field>

          <p className="text-xs text-muted">
            By continuing, the information shown above will be used to create an account on this platform.
            Our Terms of Service and Privacy Policy apply.
          </p>

          {error && <p className="text-sm text-danger">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {settings.requirePasskeyAtRegistration && <KeyRound className="h-4 w-4" />}
            {submitting ? "Working…" : settings.requirePasskeyAtRegistration ? "Continue with passkey" : "Continue"}
          </button>
        </form>
      </div>
    </Center>
  );
}

// ---- Sub-components ----

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-6">{children}</div>;
}

function Spinner() {
  return <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">{label}</label>
      {children}
    </div>
  );
}

function ReadOnlyInput({ value, mono }: { value: string; mono?: boolean }) {
  return (
    <input
      readOnly
      value={value}
      className={`w-full cursor-default rounded-xl border border-border bg-panel2 px-4 py-2.5 text-sm text-muted outline-none ${mono ? "font-mono" : ""}`}
    />
  );
}

function ProfileCard({
  user,
  buttonLabel,
  onAction,
  disabled,
  error,
}: {
  user: UserView | null;
  buttonLabel: string;
  onAction: () => void;
  disabled?: boolean;
  error: string | null;
}) {
  const initials = (user?.displayName ?? "?").slice(0, 1).toUpperCase();
  return (
    <Center>
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-panel">
        <div
          className="h-28 w-full bg-gradient-to-br from-accent/40 to-accent/10"
          style={user?.bannerUrl ? { backgroundImage: `url(${user.bannerUrl})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
        />
        <div className="-mt-10 flex flex-col items-center gap-3 p-6">
          <div className="h-20 w-20 overflow-hidden rounded-full border-4 border-panel bg-panel2 flex items-center justify-center text-2xl font-semibold text-muted">
            {user?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : initials}
          </div>
          <div className="text-center">
            <p className="text-base font-semibold">Welcome back, {user?.displayName ?? "friend"}.</p>
          </div>
          <button
            type="button"
            onClick={onAction}
            disabled={disabled}
            className="mt-2 w-full rounded-xl bg-accent py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {buttonLabel}
          </button>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      </div>
    </Center>
  );
}
