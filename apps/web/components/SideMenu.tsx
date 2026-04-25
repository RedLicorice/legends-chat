import Link from "next/link";
import { Shield, Users, MessageSquare, Home, Bot, AlertTriangle, Mail, Ban, Settings } from "lucide-react";
import type { CurrentUser } from "@/lib/auth";
import { PERMISSIONS } from "@legends/shared";

export function SideMenu({ user }: { user: CurrentUser }) {
  const isStaff =
    user.permissions.has(PERMISSIONS.MODERATION_QUEUE_REVIEW) || user.permissions.has(PERMISSIONS.ADMIN_CONFIG);
  const isAdmin = user.permissions.has(PERMISSIONS.ADMIN_CONFIG);

  return (
    <aside className="hidden h-screen w-64 shrink-0 border-r border-border bg-panel md:flex md:flex-col">
      <div className="flex items-center gap-3 border-b border-border p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-white">
          {user.displayName.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{user.displayName}</div>
          <div className="text-xs uppercase tracking-wide text-muted">{user.role}</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-2">
        {isStaff && (
          <NavLink href="/admin" icon={<Shield className="h-4 w-4" />} label="Admin Home" />
        )}
        {isAdmin && (
          <NavLink href="/admin/topics" icon={<MessageSquare className="h-4 w-4" />} label="Topics" />
        )}
        {isAdmin && (
          <NavLink href="/admin/users" icon={<Users className="h-4 w-4" />} label="Users" />
        )}
        {user.permissions.has(PERMISSIONS.BOTS_MANAGE) && (
          <NavLink href="/admin/bots" icon={<Bot className="h-4 w-4" />} label="Bots" />
        )}

        {isStaff && (
          <div className="mt-2 mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted">
            Moderation
          </div>
        )}
        {user.permissions.has(PERMISSIONS.MODERATION_QUEUE_REVIEW) && (
          <NavLink href="/admin/moderation" icon={<AlertTriangle className="h-4 w-4" />} label="Mod Queue" />
        )}
        {isAdmin && (
          <NavLink href="/admin/invites" icon={<Mail className="h-4 w-4" />} label="Invites" />
        )}
        {isAdmin && (
          <NavLink href="/admin/bans" icon={<Ban className="h-4 w-4" />} label="Bans & Mutes" />
        )}

        {isAdmin && (
          <>
            <div className="mt-2 mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted">
              Config
            </div>
            <NavLink href="/admin/settings" icon={<Settings className="h-4 w-4" />} label="Settings" />
          </>
        )}
      </nav>

      <div className="border-t border-border p-2">
        <NavLink href="/" icon={<Home className="h-4 w-4" />} label="Back to chat" />
      </div>
    </aside>
  );
}

function NavLink({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel2"
    >
      {icon} {label}
    </Link>
  );
}
