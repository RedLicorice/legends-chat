"use client";

import { useEffect, useRef, useState } from "react";
import { X, Camera, LogOut, Mail, CheckCircle, Wallet } from "lucide-react";
import { WalletAuthButton } from "@/components/WalletAuthButton";
import { PasskeyPanel } from "@/components/PasskeyPanel";

interface Props {
  user: { id: string; displayName: string; avatarUrl: string | null; role: string; presenceOptOut?: boolean; permissions?: string[] };
  onClose: () => void;
  onUpdate: (patch: { displayName?: string; avatarUrl?: string | null; presenceOptOut?: boolean }) => void;
}

export function UserProfileModal({ user, onClose, onUpdate }: Props) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl);
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [presenceOptOut, setPresenceOptOut] = useState(user.presenceOptOut ?? false);
  const [uploading, setUploading] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLInputElement>(null);

  // Email linking
  const [linkedEmail, setLinkedEmail] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [otpInput, setOtpInput] = useState("");
  const [emailStep, setEmailStep] = useState<"idle" | "otp">("idle");
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSuccess, setEmailSuccess] = useState(false);

  // Wallet linking
  const [walletAddress, setWalletAddress] = useState<string | null | undefined>(undefined);
  const [unlinkingWallet, setUnlinkingWallet] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/user/profile").then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch("/api/user/wallet").then((r) => r.ok ? r.json() : null).catch(() => null),
    ]).then(([profile, wallet]) => {
      if (profile?.email) setLinkedEmail(profile.email);
      if (profile?.bannerUrl != null) setBannerUrl(profile.bannerUrl);
      setWalletAddress(wallet?.walletAddress ?? null);
    });
  }, []);

  async function unlinkWallet() {
    setUnlinkingWallet(true);
    setWalletError(null);
    try {
      const r = await fetch("/api/user/wallet", { method: "DELETE" });
      if (!r.ok) { const d = await r.json() as { error?: string }; throw new Error(d.error ?? "Failed to unlink."); }
      setWalletAddress(null);
    } catch (e) {
      setWalletError((e as Error).message);
    } finally {
      setUnlinkingWallet(false);
    }
  }

  async function sendOtp() {
    setEmailLoading(true);
    setEmailError(null);
    try {
      const res = await fetch("/api/user/email-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: emailInput.trim().toLowerCase() }),
      });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? "Failed to send code.");
      setEmailStep("otp");
    } catch (e) {
      setEmailError((e as Error).message);
    } finally {
      setEmailLoading(false);
    }
  }

  async function verifyOtp() {
    setEmailLoading(true);
    setEmailError(null);
    try {
      const res = await fetch("/api/user/email-link/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ otp: otpInput.trim() }),
      });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? "Invalid code.");
      setLinkedEmail(emailInput.trim().toLowerCase());
      setEmailSuccess(true);
      setEmailStep("idle");
      setEmailInput("");
      setOtpInput("");
    } catch (e) {
      setEmailError((e as Error).message);
    } finally {
      setEmailLoading(false);
    }
  }

  async function uploadBanner(file: File) {
    setUploadingBanner(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("bucket", "avatars");
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json() as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? "upload failed");
      setBannerUrl(data.url);
      await fetch("/api/user/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bannerUrl: data.url }),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploadingBanner(false);
    }
  }

  async function uploadAvatar(file: File) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("bucket", "avatars");
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json() as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? "upload failed");
      setAvatarUrl(data.url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/user/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: displayName.trim(), avatarUrl, bannerUrl, presenceOptOut }),
      });
      if (!res.ok) throw new Error("save failed");
      onUpdate({ displayName: displayName.trim(), avatarUrl, presenceOptOut });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const initials = displayName.slice(0, 1).toUpperCase();

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-2xl border border-border bg-panel shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Banner */}
        <div className="relative h-28 bg-gradient-to-br from-accent/40 to-accent2/40">
          {bannerUrl && <img src={bannerUrl} alt="" className="h-full w-full object-cover" />}
          <button
            type="button"
            onClick={() => bannerRef.current?.click()}
            disabled={uploadingBanner}
            className="absolute inset-0 flex items-center justify-center bg-black/0 hover:bg-black/40 transition group"
            title="Change banner"
          >
            <Camera className="h-5 w-5 text-white opacity-0 group-hover:opacity-100 transition" />
          </button>
          <input
            ref={bannerRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadBanner(f); }}
          />
          <button type="button" onClick={onClose} className="absolute top-3 right-3 rounded-full bg-black/40 p-1 text-white hover:bg-black/60">
            <X className="h-4 w-4" />
          </button>
          {uploadingBanner && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs text-white">Uploading…</div>
          )}
        </div>

        {/* Avatar overlapping banner */}
        <div className="relative px-5 pb-0 -mt-10 mb-3 flex items-end gap-3">
          <div className="relative shrink-0">
            <div className="h-20 w-20 overflow-hidden rounded-full border-4 border-panel bg-accent">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-2xl font-semibold text-white">
                  {initials}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="absolute bottom-0 right-0 flex h-7 w-7 items-center justify-center rounded-full border-2 border-panel bg-accent2 text-white hover:opacity-90 disabled:opacity-50"
            >
              <Camera className="h-3.5 w-3.5" />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAvatar(f); }}
            />
          </div>
          <div className="pb-1 min-w-0">
            <p className="truncate font-semibold">{displayName}</p>
            {uploading && <p className="text-xs text-muted">Uploading…</p>}
          </div>
        </div>

        <div className="px-5 pb-5 space-y-4">
        <div className="space-y-2">
          <label className="block text-xs font-medium uppercase tracking-wide text-muted">Display name</label>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={64}
            className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </div>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-panel2">
          <div className="flex-1">
            <div className="text-sm font-medium">Hide online status</div>
            <div className="text-xs text-muted">When on, you appear offline and cannot see others' status</div>
          </div>
          <div className="relative mt-0.5">
            <input
              type="checkbox"
              className="sr-only"
              checked={presenceOptOut}
              onChange={(e) => setPresenceOptOut(e.target.checked)}
            />
            <div className={`h-5 w-9 rounded-full transition ${presenceOptOut ? "bg-accent" : "bg-panel2 border border-border"}`}>
              <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${presenceOptOut ? "translate-x-4" : "translate-x-0.5"}`} />
            </div>
          </div>
        </label>

        {/* Email linking */}
        <div className="mb-4 rounded-lg border border-border p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Mail className="h-4 w-4 text-muted" />
            <span>Email</span>
            {emailSuccess && <CheckCircle className="h-3.5 w-3.5 text-green-500 ml-auto" />}
          </div>
          {linkedEmail ? (
            <p className="text-xs text-muted">{linkedEmail}</p>
          ) : emailStep === "idle" ? (
            <div className="flex gap-2">
              <input
                type="email"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="you@example.com"
                className="min-w-0 flex-1 rounded-md border border-border bg-panel2 px-2 py-1.5 text-xs outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={sendOtp}
                disabled={emailLoading || !emailInput.trim()}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {emailLoading ? "…" : "Link"}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted">Code sent to {emailInput}.</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={otpInput}
                  onChange={(e) => setOtpInput(e.target.value)}
                  placeholder="6-digit code"
                  maxLength={6}
                  className="min-w-0 flex-1 rounded-md border border-border bg-panel2 px-2 py-1.5 text-xs outline-none focus:border-accent font-mono tracking-widest"
                />
                <button
                  type="button"
                  onClick={verifyOtp}
                  disabled={emailLoading || otpInput.length < 6}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {emailLoading ? "…" : "Verify"}
                </button>
              </div>
              <button type="button" onClick={() => { setEmailStep("idle"); setEmailError(null); }} className="text-xs text-muted hover:text-text">
                ← Back
              </button>
            </div>
          )}
          {emailError && <p className="text-xs text-danger">{emailError}</p>}
        </div>

        {/* Wallet linking */}
        {walletAddress !== undefined && (
          <div className="mb-4 rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Wallet className="h-4 w-4 text-muted" />
              <span>Web3 Wallet</span>
            </div>
            {walletAddress ? (
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs text-muted">{walletAddress}</span>
                <button
                  type="button"
                  onClick={unlinkWallet}
                  disabled={unlinkingWallet}
                  className="shrink-0 rounded-md px-2 py-1 text-xs text-danger hover:bg-panel2 disabled:opacity-50"
                >
                  {unlinkingWallet ? "…" : "Unlink"}
                </button>
              </div>
            ) : (
              <WalletAuthButton mode="link" onSuccess={() => {
                fetch("/api/user/wallet").then((r) => r.ok ? r.json() : null).then((d) => setWalletAddress(d?.walletAddress ?? null)).catch(() => {});
              }} />
            )}
            {walletError && <p className="text-xs text-danger">{walletError}</p>}
          </div>
        )}

        {/* Passkeys */}
        <div className="rounded-lg border border-border p-3">
          <PasskeyPanel />
        </div>

        {error && <p className="mb-3 text-xs text-danger">{error}</p>}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving || uploading || !displayName.trim()}
            className="flex-1 rounded-lg bg-accent py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-panel2"
            >
              <LogOut className="h-4 w-4" />
              Log out
            </button>
          </form>
        </div>
        </div>{/* end px-5 pb-5 */}
      </div>
    </div>

    </>
  );
}
