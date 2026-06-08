"use client";

import { AdminPanel } from "@/components/views/AdminPanel";
import { AdminUsersForm } from "@/components/AdminUsersForm";
import { useAdminGate } from "@/lib/hooks/use-admin-gate";

const REQUIRED = ["admin.config"];

export function AdminUsersView() {
  const { status, me } = useAdminGate(REQUIRED);

  return (
    <AdminPanel status={status}>
      {me && (
        <main className="flex-1 p-4 sm:p-8">
          <h1 className="mb-2 text-2xl font-semibold">Users</h1>
          <p className="mb-6 text-sm text-muted">Search members and change their roles.</p>
          <AdminUsersForm currentUserId={me.id} />
        </main>
      )}
    </AdminPanel>
  );
}
