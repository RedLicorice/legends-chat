"use client";

import { useEffect } from "react";
import { PWASplash } from "@/components/PWASplash";
import { AdminRolesForm } from "@/components/AdminRolesForm";
import { useAdminRoles } from "@/lib/hooks/use-admin-roles";

export function AdminRolesClient() {
  const { data, status } = useAdminRoles();

  useEffect(() => {
    if (status === "unauthenticated") window.location.replace("/login");
  }, [status]);

  if (status === "loading" || status === "unauthenticated") return <PWASplash />;
  if (status === "forbidden") {
    return (
      <main className="flex-1 p-8">
        <p className="text-sm text-muted">You don&apos;t have permission to view this page.</p>
      </main>
    );
  }
  if (status === "error" || !data) {
    return (
      <main className="flex-1 p-8">
        <p className="text-sm text-muted">Failed to load roles. Try refreshing.</p>
      </main>
    );
  }

  return (
    <main className="flex-1 p-4 sm:p-8">
      <h1 className="mb-2 text-2xl font-semibold">Roles</h1>
      <p className="mb-6 text-sm text-muted">
        Manage roles and their permissions. System roles (user, moderator, admin) cannot be deleted.
      </p>
      <AdminRolesForm roles={data} />
    </main>
  );
}
