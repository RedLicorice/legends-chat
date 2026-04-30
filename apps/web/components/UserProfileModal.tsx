"use client";
import { apiFetch } from "@/lib/fetch";
import { uploadFile } from "@/lib/upload";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Camera, LogOut } from "lucide-react";
import Link from "next/link";
import { Settings } from "lucide-react";

interface Props {
  user: { id: string; displayName: string; avatarUrl: string | null; role: string; presenceOptOut?: boolean; permissions?: string[] };
  onClose: () => void;
  onUpdate: (patch: { displayName?: string; avatarUrl?: string | null; presenceOptOut?: boolean }) => void;
}

export function UserProfileModal({ user, onClose, onUpdate }: Props) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl);
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [presenceOptOut, setPresenceOptOut] = useState(user.presenceOptOut ?? false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [bannerProgress, setBannerProgress] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiFetch("/api/user/profile").then((r) => r.ok ? r.json() : null).catch(() => null).then((profile) => {
      if (profile?.bannerUrl != null) setBannerUrl(profile.bannerUrl);
    });
  }, []);

  async function uploadBanner(file: File) {
    setUploadingBanner(true);
    setBannerProgress(0);
    setError(null);
    try {
      const url = await uploadFile(file, "avatars", setBannerProgress);
      setBannerUrl(url);
      await apiFetch("/api/user/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bannerUrl: url }),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploadingBanner(false);
    }
  }

  async function uploadAvatar(file: File) {
    setUploading(true);
    setUploadProgress(0);
    setError(null);
    try {
      const url = await uploadFile(file, "avatars", setUploadProgress);
      setAvatarUrl(url);
      await apiFetch("/api/user/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ avatarUrl: url }),
      });
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
      const res = await apiFetch("/api/user/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: displayName.trim(), avatarUrl, bannerUrl, presenceOptOut }),
      });
      if (!res.ok) throw new Error("save failed");
      onUpdate({ displayName: displayName.trim(), avatarUrl, presenceOptOut });
      router.refresh();
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
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) uploadBanner(f); }}
          />
          <button type="button" onClick={onClose} className="absolute top-3 right-3 rounded-full bg-black/40 p-1 text-white hover:bg-black/60">
            <X className="h-4 w-4" />
          </button>
          {uploadingBanner && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs text-white">
              {bannerProgress < 100 ? `${bannerProgress}%` : "Processing…"}
            </div>
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
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) uploadAvatar(f); }}
            />
          </div>
          <div className="pb-1 min-w-0">
            <p className="truncate font-semibold">{displayName}</p>
            {uploading && <p className="text-xs text-muted">{uploadProgress < 100 ? `${uploadProgress}%` : "Processing…"}</p>}
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
          <Link
            href="/settings"
            onClick={onClose}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-panel2"
          >
            <Settings className="h-4 w-4" />
          </Link>
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-panel2"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </form>
        </div>
        </div>{/* end px-5 pb-5 */}
      </div>
    </div>

    </>
  );
}
