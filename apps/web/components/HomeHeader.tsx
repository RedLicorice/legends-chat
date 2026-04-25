"use client";

import { useEffect, useState } from "react";
import { Shield, AlertTriangle, Menu, X } from "lucide-react";
import Link from "next/link";
import { PERMISSIONS } from "@legends/shared";
import { UserProfileModal } from "@/components/UserProfileModal";
import { ModQueueModal } from "@/components/ModQueueModal";

interface Props {
  user: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    role: string;
    presenceOptOut: boolean;
    permissions: string[];
  };
}

export function HomeHeader({ user }: Props) {
  const [profile, setProfile] = useState({ displayName: user.displayName, avatarUrl: user.avatarUrl });
  const [showProfile, setShowProfile] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [showModQueue, setShowModQueue] = useState(false);
  const [pendingFlags, setPendingFlags] = useState<number | null>(null);

  const isStaff =
    user.permissions.includes(PERMISSIONS.MODERATION_QUEUE_REVIEW) ||
    user.permissions.includes(PERMISSIONS.ADMIN_CONFIG);
  const canModQueue = user.permissions.includes(PERMISSIONS.MODERATION_QUEUE_REVIEW);
  const initials = profile.displayName.slice(0, 1).toUpperCase();

  useEffect(() => {
    if (!canModQueue) return;
    fetch("/api/admin/moderation/flags")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setPendingFlags((d.flags as unknown[]).length); })
      .catch(() => {});
  }, [canModQueue]);

  return (
    <>
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowSidebar(true)}
            className="rounded-md p-1 hover:bg-panel2 transition"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-lg font-semibold tracking-tight">Legends Chat</span>
        </div>
        <button
          type="button"
          onClick={() => setShowProfile(true)}
          className="h-9 w-9 overflow-hidden rounded-full bg-accent hover:opacity-90 transition"
        >
          {profile.avatarUrl ? (
            <img src={profile.avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-white">
              {initials}
            </div>
          )}
        </button>
      </header>

      {showSidebar && (
        <div className="fixed inset-0 z-40 bg-black/60" onClick={() => setShowSidebar(false)} />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-border bg-panel transition-transform duration-200 ${showSidebar ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center justify-between border-b border-border p-4">
          <span className="font-semibold tracking-tight">Legends Chat</span>
          <button
            type="button"
            onClick={() => setShowSidebar(false)}
            className="rounded-md p-1 hover:bg-panel2 transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <button
          type="button"
          onClick={() => { setShowProfile(true); setShowSidebar(false); }}
          className="flex items-center gap-3 border-b border-border p-4 text-left hover:bg-panel2 transition"
        >
          <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-accent">
            {profile.avatarUrl ? (
              <img src={profile.avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-white">
                {initials}
              </div>
            )}
          </div>
          <div className="min-w-0">
            <div className="truncate font-medium">{profile.displayName}</div>
            <div className="text-xs uppercase tracking-wide text-muted">{user.role}</div>
          </div>
        </button>

        {canModQueue && (
          <button
            type="button"
            onClick={() => { setShowModQueue(true); setShowSidebar(false); }}
            className="mx-2 mt-2 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400 hover:bg-amber-500/20 transition"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="font-medium">Mod Queue</span>
            {pendingFlags !== null && pendingFlags > 0 && (
              <span className="ml-auto rounded-full bg-amber-500 px-1.5 py-0.5 text-xs font-semibold text-white">
                {pendingFlags}
              </span>
            )}
          </button>
        )}

        {isStaff && (
          <div className="mt-auto border-t border-border p-3">
            <Link
              href="/admin"
              onClick={() => setShowSidebar(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel2"
            >
              <Shield className="h-4 w-4" /> Admin
            </Link>
          </div>
        )}
      </aside>

      {showProfile && (
        <UserProfileModal
          user={{ ...user, ...profile }}
          onClose={() => setShowProfile(false)}
          onUpdate={(patch) => setProfile((p) => ({ ...p, ...patch }))}
        />
      )}
      {showModQueue && <ModQueueModal onClose={() => setShowModQueue(false)} />}
    </>
  );
}
