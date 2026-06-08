"use client";

import { AdminPanel } from "@/components/views/AdminPanel";
import { AdminRolesForm } from "@/components/AdminRolesForm";
import { useAdminRoles } from "@/lib/hooks/use-admin-roles";

export function AdminRolesView() {
  const { data, status } = useAdminRoles();

  return (
    <AdminPanel status={status} errorMessage="Failed to load roles. Try refreshing.">
      {data && (
        <main className="flex-1 p-4 sm:p-8">
          <h1 className="mb-2 text-2xl font-semibold">Roles</h1>
          <p className="mb-6 text-sm text-muted">
            Manage roles and their permissions. System roles (user, moderator, admin) cannot be deleted.
          </p>
          <AdminRolesForm roles={data} />
        </main>
      )}
    </AdminPanel>
  );
}
