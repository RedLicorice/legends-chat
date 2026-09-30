"use client";
import { apiFetch } from "@/lib/fetch";

import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import QRCode from "qrcode";

interface TotpStatus {
  enabled: boolean;
  uri?: string;
  secret?: string;
  recoveryCodesRemaining?: number;
}

export function TotpPanel() {
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Shown exactly once, right after enrolment: the server stores only hashes
  // and has no endpoint that can show them again.
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [recoverySaved, setRecoverySaved] = useState(false);

  async function load() {
    const res = await apiFetch("/api/user/totp");
    if (res.ok) {
      const data = await res.json() as TotpStatus;
      setStatus(data);
      if (data.uri) {
        QRCode.toDataURL(data.uri, { width: 200, margin: 1 })
          .then(setQrDataUrl)
          .catch(() => {});
      }
    }
  }

  useEffect(() => { void load(); }, []);

  async function confirm() {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch("/api/user/totp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json() as { error?: string; recoveryCodes?: string[] };
      if (!res.ok) { setError(data.error ?? "Error"); return; }
      setSuccess("2FA enabled.");
      setCode("");
      if (data.recoveryCodes?.length) {
        setRecoveryCodes(data.recoveryCodes);
        setRecoverySaved(false);
      }
      await load();
    } catch { setError("Network error."); }
    finally { setLoading(false); }
  }

  async function disable() {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch("/api/user/totp", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, password }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) { setError(data.error ?? "Error"); return; }
      setSuccess("2FA disabled.");
      setCode("");
      setPassword("");
      setRecoveryCodes(null);
      await load();
    } catch { setError("Network error."); }
    finally { setLoading(false); }
  }

  if (!status) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Shield className={`h-5 w-5 ${status.enabled ? "text-green-400" : "text-muted"}`} />
        <div>
          <div className="text-sm font-medium">Two-factor authentication</div>
          <div className="text-xs text-muted">{status.enabled ? "Active — your account is protected." : "Not enabled."}</div>
        </div>
      </div>

      {recoveryCodes && (
        <div className="space-y-3 rounded-lg border border-accent bg-panel2 p-4">
          <div className="text-sm font-medium">Save your recovery codes</div>
          <p className="text-xs text-muted">
            Each code works once, in place of an authenticator code, if you lose your
            device. This is the only time they will be shown — store them somewhere safe.
          </p>
          <div className="grid grid-cols-2 gap-1 font-mono text-sm">
            {recoveryCodes.map((c) => <span key={c}>{c}</span>)}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { void navigator.clipboard?.writeText(recoveryCodes.join("\n")); }}
              className="rounded-lg border border-border px-3 py-1.5 text-xs hover:border-accent"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={() => { setRecoverySaved(true); setRecoveryCodes(null); }}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              I&apos;ve saved them
            </button>
          </div>
        </div>
      )}

      {status.enabled && !recoveryCodes && typeof status.recoveryCodesRemaining === "number" && (
        <p className="text-xs text-muted">
          {status.recoveryCodesRemaining > 0
            ? `${status.recoveryCodesRemaining} recovery code${status.recoveryCodesRemaining === 1 ? "" : "s"} remaining.`
            : "No recovery codes left — disable and re-enable 2FA to get a new set."}
        </p>
      )}

      {!status.enabled && status.uri && (
        <div className="space-y-3">
          <p className="text-sm text-muted">Scan with Google Authenticator, Authy, or any TOTP app.</p>
          {qrDataUrl && <img src={qrDataUrl} alt="TOTP QR" className="rounded-lg border border-border" />}
          <p className="text-xs font-mono break-all text-muted">{status.secret}</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="6-digit code"
              className="w-36 rounded-lg border border-border bg-panel2 px-3 py-2 text-sm font-mono outline-none focus:border-accent"
            />
            <button
              onClick={confirm}
              disabled={loading || code.length !== 6}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Verifying…" : "Enable 2FA"}
            </button>
          </div>
        </div>
      )}

      {status.enabled && (
        <div className="space-y-2">
          <p className="text-sm text-muted">
            Turning 2FA off needs both a current code and your password.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="6-digit code"
              className="w-36 rounded-lg border border-border bg-panel2 px-3 py-2 text-sm font-mono outline-none focus:border-accent"
            />
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-48 rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button
              onClick={disable}
              disabled={loading || code.length !== 6}
              className="rounded-lg border border-danger px-4 py-2 text-sm font-medium text-danger hover:bg-danger hover:text-white disabled:opacity-50"
            >
              {loading ? "Disabling…" : "Disable 2FA"}
            </button>
          </div>
          <p className="text-xs text-muted">
            Accounts without a password (Telegram or passkey only) can leave the password field blank.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
      {success && <p className="text-sm text-green-400">{success}</p>}
      {recoverySaved && !recoveryCodes && <p className="text-xs text-muted">Recovery codes saved.</p>}
    </div>
  );
}
