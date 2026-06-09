"use client";
import { apiFetch } from "@/lib/fetch";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Shield, MessageSquare } from "lucide-react";
import Link from "next/link";
import { PERMISSIONS } from "@legends/shared";
import { useMe } from "@/lib/hooks/use-me";

interface UserProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  bio: string | null;
}

interface Props {
  userId: string;
  viewerPermissions: string[];
  onClose: () => void;
}

export function UserViewModal({ userId, viewerPermissions, onClose }: Props) {
  const router = useRouter();
  const { me } = useMe();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [dmBusy, setDmBusy] = useState(false);
  const [dmError, setDmError] = useState<string | null>(null);

  const canAdmin = viewerPermissions.includes(PERMISSIONS.ADMIN_CONFIG);

  useEffect(() => {
    apiFetch(`/api/users/${userId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d: UserProfile | null) => { if (d) setProfile(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [userId]);

  const initials = profile?.displayName.slice(0, 1).toUpperCase() ?? "?";
  const isSelf = !!me && !!profile && me.id === profile.id;

  async function openDm() {
    if (!profile) return;
    setDmBusy(true);
    setDmError(null);
    const res = await apiFetch("/api/dm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peerType: "user", peerId: profile.id }),
    });
    if (!res.ok) {
      setDmBusy(false);
      setDmError("Could not open DM");
      return;
    }
    const data = (await res.json()) as { id: string };
    onClose();
    router.push(`/c/${data.id}`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="relative w-full max-w-xs rounded-2xl border border-border bg-panel p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1 text-muted hover:bg-panel2 hover:text-text transition"
        >
          <X className="h-4 w-4" />
        </button>

        {loading ? (
          <div className="py-8 text-center text-sm text-muted">Loading…</div>
        ) : !profile ? (
          <div className="py-8 text-center text-sm text-muted">User not found.</div>
        ) : (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="h-20 w-20 overflow-hidden rounded-full bg-accent2">
              {profile.avatarUrl ? (
                <img src={profile.avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-2xl font-semibold text-white">
                  {initials}
                </div>
              )}
            </div>
            <div>
              <div className="text-lg font-semibold">{profile.displayName}</div>
              <div className="text-xs uppercase tracking-wide text-muted">{profile.role}</div>
            </div>
            {profile.bio && <p className="text-sm text-muted whitespace-pre-wrap">{profile.bio}</p>}
            {!isSelf && (
              <div className="flex w-full flex-col items-stretch gap-1">
                <button
                  type="button"
                  onClick={openDm}
                  disabled={dmBusy}
                  className="flex items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm hover:bg-panel2 transition disabled:opacity-50"
                >
                  <MessageSquare className="h-4 w-4" /> {dmBusy ? "Opening…" : "DM User"}
                </button>
                {dmError && <p className="text-xs text-danger">{dmError}</p>}
              </div>
            )}
            {canAdmin && (
              <Link
                href={`/admin/users`}
                onClick={onClose}
                className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm hover:bg-panel2 transition"
              >
                <Shield className="h-4 w-4" /> Edit in Admin
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
