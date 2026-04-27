"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Shield, AlertTriangle, X, Settings, Download, User, Home, Menu,
  MessageSquare, Users, Bot, Mail, Ban, PanelLeftClose, PanelLeftOpen, Film, ShieldCheck, Palette, BellRing,
} from "lucide-react";
import Link from "next/link";
import { UserProfileModal } from "@/components/UserProfileModal";
import { ModQueueModal } from "@/components/ModQueueModal";
import { NotificationBell } from "@/components/NotificationBell";
import { PERMISSIONS } from "@legends/shared";
import { cn } from "@/lib/cn";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";

interface AppSidebarUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  permissions: string[];
  presenceOptOut?: boolean;
}

interface Props {
  user: AppSidebarUser;
  children: React.ReactNode;
  variant?: "chat" | "admin";
  // Mobile open/close (controlled mode for mobile overlay)
  isOpen?: boolean;
  onClose?: () => void;
  // Desktop collapsed state — if provided, component is in controlled mode for desktop
  desktopCollapsed?: boolean;
  onToggleDesktop?: () => void;
  // Callback when internal desktop collapse changes (uncontrolled mode)
  onCollapseChange?: (c: boolean) => void;
  // "minimal": collapsed sidebar takes no space; "strip": w-12 icon bar
  compactMode?: "minimal" | "strip";
  // Icon-only content for strip mode middle section
  iconChildren?: React.ReactNode;
}

const STORAGE_KEY = "sidebar-collapsed";

export function AppSidebar({
  user,
  children,
  variant = "chat",
  isOpen: isOpenProp,
  onClose: onCloseProp,
  desktopCollapsed: desktopCollapsedProp,
  onToggleDesktop,
  onCollapseChange,
  compactMode: compactModeProp,
  iconChildren,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const controlledMobile = isOpenProp !== undefined;
  const isOpen = controlledMobile ? isOpenProp : internalOpen;
  const close = controlledMobile ? (onCloseProp ?? (() => {})) : () => setInternalOpen(false);

  // Desktop collapsed: controlled mode if desktopCollapsedProp is provided
  const controlledDesktop = desktopCollapsedProp !== undefined;
  const [internalDesktopCollapsed, setInternalDesktopCollapsed] = useState(false);
  useEffect(() => {
    if (!controlledDesktop) {
      setInternalDesktopCollapsed(localStorage.getItem(STORAGE_KEY) === "true");
    }
  }, [controlledDesktop]);

  const desktopCollapsed = controlledDesktop ? desktopCollapsedProp : internalDesktopCollapsed;

  function toggleDesktop() {
    if (controlledDesktop) {
      onToggleDesktop?.();
    } else {
      setInternalDesktopCollapsed((v) => {
        const n = !v;
        localStorage.setItem(STORAGE_KEY, String(n));
        onCollapseChange?.(n);
        return n;
      });
    }
  }

  // Compact mode: prop or read from html data attribute
  const [resolvedCompactMode, setResolvedCompactMode] = useState<"minimal" | "strip">(compactModeProp ?? "minimal");
  useEffect(() => {
    if (compactModeProp) {
      setResolvedCompactMode(compactModeProp);
    } else if (variant === "admin") {
      setResolvedCompactMode("strip");
    } else {
      const attr = document.documentElement.dataset.sidebarCompact as "minimal" | "strip" | undefined;
      setResolvedCompactMode(attr === "strip" ? "strip" : "minimal");
    }
  }, [compactModeProp, variant]);

  // For admin variant, always use strip mode
  const effectiveCompactMode = variant === "admin" ? "strip" : resolvedCompactMode;

  const [profile, setProfile] = useState({ displayName: user.displayName, avatarUrl: user.avatarUrl });
  const [showProfile, setShowProfile] = useState(false);
  const [showModQueue, setShowModQueue] = useState(false);
  const [pendingFlags, setPendingFlags] = useState<number | null>(null);
  const [showIosInstall, setShowIosInstall] = useState(false);
  const [showAndroidInstall, setShowAndroidInstall] = useState(false);

  const installState = useInstallPrompt();

  const has = (p: string) => user.permissions.includes(p);
  const isStaff = has(PERMISSIONS.MODERATION_QUEUE_REVIEW) || has(PERMISSIONS.ADMIN_CONFIG);
  const isAdmin = has(PERMISSIONS.ADMIN_CONFIG);
  const canModQueue = has(PERMISSIONS.MODERATION_QUEUE_REVIEW);

  const refreshFlagCount = useCallback(() => {
    if (!canModQueue) return;
    fetch("/api/admin/moderation/flags")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setPendingFlags((d.flags as unknown[]).length); })
      .catch(() => {});
  }, [canModQueue]);

  useEffect(() => {
    refreshFlagCount();
    if (!canModQueue) return;
    const id = setInterval(refreshFlagCount, 30_000);
    return () => clearInterval(id);
  }, [canModQueue, refreshFlagCount]);

  const initials = profile.displayName.slice(0, 1).toUpperCase();

  // Strip mode: collapsed desktop shows icon strip
  const showStrip = desktopCollapsed && effectiveCompactMode === "strip";
  // Minimal mode: collapsed desktop hides sidebar entirely
  const showMinimalHidden = desktopCollapsed && effectiveCompactMode === "minimal";

  return (
    <>
      {/* Uncontrolled mobile hamburger */}
      {!controlledMobile && (
        <button
          type="button"
          onClick={() => setInternalOpen(true)}
          className="fixed left-4 top-4 z-40 rounded-md p-2 hover:bg-panel2 transition md:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
      )}

      {isOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={close} />
      )}

      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 flex h-full shrink-0 flex-col border-r border-border bg-panel transition-all duration-200",
        "md:relative md:z-auto",
        // Mobile: controlled by isOpen (always full width)
        isOpen ? "w-72 translate-x-0" : "w-72 -translate-x-full md:translate-x-0",
        // Desktop: width depends on collapse mode
        showMinimalHidden ? "md:w-0 md:border-r-0" : showStrip ? "md:w-12" : "md:w-72",
      )}>
        {/* Strip mode: collapsed icon strip — desktop only */}
        {showStrip && (
          <div className="hidden md:flex flex-col items-center h-full">
            {/* Expand button at top */}
            <div className="shrink-0 py-2">
              <button
                type="button"
                onClick={toggleDesktop}
                title="Expand sidebar"
                className="rounded-lg p-2 text-muted hover:text-text hover:bg-panel2 transition"
              >
                <PanelLeftOpen className="h-5 w-5" />
              </button>
            </div>
            {/* Icon children in middle (scrollable) */}
            <div className="flex-1 overflow-y-auto w-full flex flex-col items-center">
              {iconChildren}
            </div>
            {/* Footer icons at bottom */}
            <div className="shrink-0 py-2 flex flex-col items-center gap-1">
              {variant === "admin" ? (
                <Link href="/" title="Back to chat" className="rounded-lg p-2 text-muted hover:text-text hover:bg-panel2 transition">
                  <Home className="h-5 w-5" />
                </Link>
              ) : (
                <>
                  <Link href="/" title="Home" className="rounded-lg p-2 text-muted hover:text-text hover:bg-panel2 transition">
                    <Home className="h-5 w-5" />
                  </Link>
                  <Link href="/settings" title="Settings" className="rounded-lg p-2 text-muted hover:text-text hover:bg-panel2 transition">
                    <Settings className="h-5 w-5" />
                  </Link>
                  {isStaff && (
                    <Link href="/admin" title="Admin" className="rounded-lg p-2 text-muted hover:text-text hover:bg-panel2 transition">
                      <Shield className="h-5 w-5" />
                    </Link>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Full sidebar — always on mobile, hidden on desktop when collapsed */}
        <div className={cn("flex h-full min-h-0 flex-col", (showStrip || showMinimalHidden) && "md:hidden")}>
          {/* Header */}
          <div className="flex items-center gap-1 border-b border-border px-3 py-3">
            <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full bg-accent">
              {profile.avatarUrl ? (
                <img src={profile.avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-white">
                  {initials}
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1 px-2">
              <div className="truncate text-sm font-medium">{profile.displayName}</div>
              <div className="text-xs uppercase tracking-wide text-muted">{user.role}</div>
            </div>
            <button
              type="button"
              onClick={() => setShowProfile(true)}
              title="Profile"
              className="rounded-lg p-1.5 text-muted hover:text-text hover:bg-panel2 transition"
            >
              <User className="h-4 w-4" />
            </button>
            <NotificationBell align="left" />
            {canModQueue && (
              <button
                type="button"
                onClick={() => setShowModQueue(true)}
                title="Mod Queue"
                className="relative rounded-lg p-1.5 text-amber-400 hover:bg-panel2 transition"
              >
                <AlertTriangle className="h-4 w-4" />
                {pendingFlags !== null && pendingFlags > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white leading-none">
                    {pendingFlags}
                  </span>
                )}
              </button>
            )}
            {/* Desktop collapse toggle */}
            <button
              type="button"
              onClick={toggleDesktop}
              title="Collapse sidebar"
              className="hidden rounded-lg p-1.5 text-muted hover:text-text hover:bg-panel2 transition md:flex"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
            {/* Mobile close */}
            <button
              type="button"
              onClick={close}
              className="rounded-lg p-1.5 text-muted hover:text-text hover:bg-panel2 transition md:hidden"
              aria-label="Close menu"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Middle — scrollable content (topics list or admin nav) */}
          <div className="flex-1 overflow-y-auto p-2">
            {children}
          </div>

          {/* Footer */}
          <div className="border-t border-border p-3 space-y-0.5">
            {variant === "admin" ? (
              <Link
                href="/"
                className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel2"
              >
                <Home className="h-4 w-4" /> Back to chat
              </Link>
            ) : (
              <>
                <Link
                  href="/"
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel2"
                >
                  <Home className="h-4 w-4" /> Home
                </Link>
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
              </>
            )}
            {installState.type === "native" && (
              <button
                type="button"
                onClick={installState.install}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel2"
              >
                <Download className="h-4 w-4" /> Install app
              </button>
            )}
            {installState.type === "ios" && (
              <button
                type="button"
                onClick={() => setShowIosInstall(true)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel2"
              >
                <Download className="h-4 w-4" /> Install app
              </button>
            )}
            {installState.type === "android" && (
              <button
                type="button"
                onClick={() => setShowAndroidInstall(true)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel2"
              >
                <Download className="h-4 w-4" /> Install app
              </button>
            )}
          </div>
        </div>
      </aside>

      {showProfile && (
        <UserProfileModal
          user={{ ...user, ...profile }}
          onClose={() => setShowProfile(false)}
          onUpdate={(patch) => setProfile((p) => ({ ...p, ...patch }))}
        />
      )}

      {showModQueue && (
        <ModQueueModal
          onClose={() => setShowModQueue(false)}
          onCountChange={(n) => setPendingFlags(n)}
        />
      )}

      {showIosInstall && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-4 md:items-center">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-panel p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Install on iPhone / iPad</h2>
              <button type="button" onClick={() => setShowIosInstall(false)} className="text-muted hover:text-text">
                <X className="h-5 w-5" />
              </button>
            </div>
            <ol className="space-y-3 text-sm text-muted">
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">1</span>
                Tap the <strong className="text-text">Share</strong> button at the bottom of Safari (the square with an arrow pointing up).
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">2</span>
                Scroll down and tap <strong className="text-text">Add to Home Screen</strong>.
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">3</span>
                Tap <strong className="text-text">Add</strong> in the top-right corner.
              </li>
            </ol>
            <button
              type="button"
              onClick={() => setShowIosInstall(false)}
              className="w-full rounded-lg bg-accent py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {showAndroidInstall && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-4 md:items-center">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-panel p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Install on Android</h2>
              <button type="button" onClick={() => setShowAndroidInstall(false)} className="text-muted hover:text-text">
                <X className="h-5 w-5" />
              </button>
            </div>
            <ol className="space-y-3 text-sm text-muted">
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">1</span>
                Tap the <strong className="text-text">menu</strong> button (⋮) in the top-right corner of Chrome.
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">2</span>
                Tap <strong className="text-text">Add to Home screen</strong>.
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">3</span>
                Tap <strong className="text-text">Add</strong> to confirm.
              </li>
            </ol>
            <button
              type="button"
              onClick={() => setShowAndroidInstall(false)}
              className="w-full rounded-lg bg-accent py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// Admin navigation — used as children inside AppSidebar for the admin layout
export function AdminNav({ permissions }: { permissions: string[] }) {
  const has = (p: string) => permissions.includes(p);
  const isAdmin = has(PERMISSIONS.ADMIN_CONFIG);
  const isStaff = has(PERMISSIONS.MODERATION_QUEUE_REVIEW) || isAdmin;

  return (
    <nav className="space-y-0.5">
      {isStaff && <NavLink href="/admin" icon={<Shield className="h-4 w-4" />} label="Admin Home" />}
      {isAdmin && <NavLink href="/admin/topics" icon={<MessageSquare className="h-4 w-4" />} label="Topics" />}
      {isAdmin && <NavLink href="/admin/roles" icon={<ShieldCheck className="h-4 w-4" />} label="Roles" />}
      {isAdmin && <NavLink href="/admin/users" icon={<Users className="h-4 w-4" />} label="Users" />}
      {has(PERMISSIONS.BOTS_MANAGE) && <NavLink href="/admin/bots" icon={<Bot className="h-4 w-4" />} label="Bots" />}

      {isStaff && (
        <p className="mt-3 mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted">
          Moderation
        </p>
      )}
      {has(PERMISSIONS.MODERATION_QUEUE_REVIEW) && (
        <NavLink href="/admin/moderation" icon={<AlertTriangle className="h-4 w-4" />} label="Mod Queue" />
      )}
      {isAdmin && <NavLink href="/admin/invites" icon={<Mail className="h-4 w-4" />} label="Invites" />}
      {isAdmin && <NavLink href="/admin/bans" icon={<Ban className="h-4 w-4" />} label="Bans & Mutes" />}
      {isAdmin && <NavLink href="/admin/gifs" icon={<Film className="h-4 w-4" />} label="GIF Library" />}
      {isAdmin && <NavLink href="/admin/notifications" icon={<BellRing className="h-4 w-4" />} label="Broadcast" />}

      {isAdmin && (
        <>
          <p className="mt-3 mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted">
            Config
          </p>
          <NavLink href="/admin/settings" icon={<Settings className="h-4 w-4" />} label="Settings" />
          <NavLink href="/admin/themes" icon={<Palette className="h-4 w-4" />} label="Themes" />
        </>
      )}
    </nav>
  );
}

function NavLink({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <Link href={href} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel2">
      {icon} {label}
    </Link>
  );
}
