"use client";

import { useEffect, useState } from "react";
import { Shield, AlertTriangle, X, Settings } from "lucide-react";
import Link from "next/link";
import { TopicListItem } from "@/components/TopicListItem";
import { UserProfileModal } from "@/components/UserProfileModal";
import { ModQueueModal } from "@/components/ModQueueModal";
import type { TopicListItem as TopicItem } from "@/lib/topics";
import { PERMISSIONS } from "@legends/shared";
import { cn } from "@/lib/cn";

interface Props {
  user: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    role: string;
    permissions: string[];
    presenceOptOut?: boolean;
  };
  topics: TopicItem[];
  currentSlug?: string;
  isOpen?: boolean;
  onClose?: () => void;
}

export function TopicsSidebar({ user, topics, currentSlug, isOpen, onClose }: Props) {
  const [profile, setProfile] = useState({
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  });
  const [showProfile, setShowProfile] = useState(false);
  const [showModQueue, setShowModQueue] = useState(false);
  const [pendingFlags, setPendingFlags] = useState<number | null>(null);

  const isStaff =
    user.permissions.includes(PERMISSIONS.MODERATION_QUEUE_REVIEW) ||
    user.permissions.includes(PERMISSIONS.ADMIN_CONFIG);
  const canModQueue = user.permissions.includes(PERMISSIONS.MODERATION_QUEUE_REVIEW);

  useEffect(() => {
    if (!canModQueue) return;
    fetch("/api/admin/moderation/flags")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setPendingFlags((d.flags as unknown[]).length); })
      .catch(() => {});
  }, [canModQueue]);

  const initials = profile.displayName.slice(0, 1).toUpperCase();

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={onClose} />
      )}
      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 flex h-full w-72 shrink-0 flex-col border-r border-border bg-panel transition-transform duration-200",
        "md:relative md:z-auto md:translate-x-0",
        isOpen ? "translate-x-0" : "-translate-x-full",
      )}>
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 rounded-md p-1 hover:bg-panel2 transition md:hidden"
        >
          <X className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => setShowProfile(true)}
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
            onClick={() => setShowModQueue(true)}
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

        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {topics.map((t) => (
            <div key={t.id} className={currentSlug === t.slug ? "opacity-100" : "opacity-90"}>
              <TopicListItem topic={t} compact />
            </div>
          ))}
        </div>

        <div className="border-t border-border p-3 space-y-0.5">
          <Link
            href="/settings"
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel2"
          >
            <Settings className="h-4 w-4" /> Settings
          </Link>
          {isStaff && (
            <Link
              href="/admin"
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel2"
            >
              <Shield className="h-4 w-4" /> Admin
            </Link>
          )}
        </div>
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
