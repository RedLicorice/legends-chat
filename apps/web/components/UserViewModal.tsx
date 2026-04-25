"use client";

import { useEffect, useState } from "react";
import { X, Shield } from "lucide-react";
import Link from "next/link";
import { PERMISSIONS } from "@legends/shared";

interface UserProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
}

interface Props {
  userId: string;
  viewerPermissions: string[];
  onClose: () => void;
}

export function UserViewModal({ userId, viewerPermissions, onClose }: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const canAdmin = viewerPermissions.includes(PERMISSIONS.ADMIN_CONFIG);

  useEffect(() => {
    fetch(`/api/users/${userId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d: UserProfile | null) => { if (d) setProfile(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [userId]);

  const initials = profile?.displayName.slice(0, 1).toUpperCase() ?? "?";

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
