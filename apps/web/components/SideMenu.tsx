import Link from "next/link";
import { Shield, LogOut } from "lucide-react";
import type { CurrentUser } from "@/lib/auth";
import { PERMISSIONS } from "@legends/shared";

export function SideMenu({ user }: { user: CurrentUser }) {
  const isStaff =
    user.permissions.has(PERMISSIONS.MODERATION_QUEUE_REVIEW) || user.permissions.has(PERMISSIONS.ADMIN_CONFIG);

  return (
    <aside className="hidden h-screen w-72 shrink-0 border-r border-border bg-panel md:flex md:flex-col">
      <div className="flex items-center gap-3 border-b border-border p-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-sm font-semibold text-white">
          {user.displayName.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="truncate font-medium">{user.displayName}</div>
          <div className="text-xs uppercase tracking-wide text-muted">{user.role}</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        <Link
          href="/"
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel2"
        >
          Topics
        </Link>
        {isStaff && (
          <Link
            href="/admin"
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel2"
          >
            <Shield className="h-4 w-4" /> Admin
          </Link>
        )}
      </nav>

      <form action="/api/auth/logout" method="post" className="border-t border-border p-3">
        <button
          type="submit"
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel2"
        >
          <LogOut className="h-4 w-4" /> Log out
        </button>
      </form>
    </aside>
  );
}
