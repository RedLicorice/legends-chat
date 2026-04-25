"use client";

import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import QRCode from "qrcode";

interface TotpStatus {
  enabled: boolean;
  uri?: string;
  secret?: string;
}

export function TotpPanel() {
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/user/totp");
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
      const res = await fetch("/api/user/totp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) { setError(data.error ?? "Error"); return; }
      setSuccess("2FA enabled.");
      setCode("");
      await load();
    } catch { setError("Network error."); }
    finally { setLoading(false); }
  }

  async function disable() {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/user/totp", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) { setError(data.error ?? "Error"); return; }
      setSuccess("2FA disabled.");
      setCode("");
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
          <p className="text-sm text-muted">Enter your current code to disable 2FA.</p>
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
              onClick={disable}
              disabled={loading || code.length !== 6}
              className="rounded-lg border border-danger px-4 py-2 text-sm font-medium text-danger hover:bg-danger hover:text-white disabled:opacity-50"
            >
              {loading ? "Disabling…" : "Disable 2FA"}
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
      {success && <p className="text-sm text-green-400">{success}</p>}
    </div>
  );
}
