"use client";

import { AdminPanel } from "@/components/views/AdminPanel";
import { AdminNotificationsForm } from "@/components/AdminNotificationsForm";
import { useAdminGate } from "@/lib/hooks/use-admin-gate";

const REQUIRED = ["admin.config"];

export function AdminNotificationsView() {
  const { status } = useAdminGate(REQUIRED);

  return (
    <AdminPanel status={status}>
      <main className="flex-1 p-4 sm:p-8 max-w-2xl">
        <h1 className="mb-2 text-2xl font-semibold">Broadcast Notifications</h1>
        <p className="mb-6 text-sm text-muted">Send a system notification to all users or a specific role.</p>
        <AdminNotificationsForm />
      </main>
    </AdminPanel>
  );
}
