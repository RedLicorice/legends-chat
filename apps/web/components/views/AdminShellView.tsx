"use client";

import { useEffect } from "react";
import { AppSidebar, AdminNav } from "@/components/AppSidebar";
import { PWASplash } from "@/components/PWASplash";
import { useMe } from "@/lib/hooks/use-me";
import { PERMISSIONS } from "@legends/shared";

/**
 * Replaces the former `app/admin/layout.tsx` (server component). Wraps every
 * admin view with the AppSidebar + AdminNav shell, and gates access to users
 * holding moderation/admin permissions. Unauth → /login; insufficient perms
 * → /. While loading, shows the PWA splash.
 */
export function AdminShellView({ children }: { children: React.ReactNode }) {
  const { me, status } = useMe();

  useEffect(() => {
    if (status === "unauthenticated") {
      window.location.replace("/login");
      return;
    }
    if (status === "authenticated" && me) {
      const hasModReview = me.permissions.includes(PERMISSIONS.MODERATION_QUEUE_REVIEW);
      const hasAdminConfig = me.permissions.includes(PERMISSIONS.ADMIN_CONFIG);
      if (!hasModReview && !hasAdminConfig) {
        window.location.replace("/");
      }
    }
  }, [status, me]);

  if (status === "loading" || status === "unauthenticated" || !me) {
    return <PWASplash />;
  }

  const hasModReview = me.permissions.includes(PERMISSIONS.MODERATION_QUEUE_REVIEW);
  const hasAdminConfig = me.permissions.includes(PERMISSIONS.ADMIN_CONFIG);
  if (!hasModReview && !hasAdminConfig) {
    return <PWASplash />;
  }

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      <AppSidebar
        user={{
          id: me.id,
          displayName: me.displayName,
          avatarUrl: me.avatarUrl ?? null,
          role: me.role,
          permissions: me.permissions,
        }}
        variant="admin"
      >
        <AdminNav permissions={me.permissions} />
      </AppSidebar>
      <div className="selectable flex flex-1 flex-col overflow-y-auto pt-[calc(3.5rem+var(--sat))] md:pt-0">
        {children}
      </div>
    </div>
  );
}
