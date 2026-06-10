"use client";

import { AdminPanel } from "@/components/views/AdminPanel";
import { BansPanel } from "@/components/BansPanel";
import { useAdminGate } from "@/lib/hooks/use-admin-gate";

const REQUIRED = ["admin.config"];

export function AdminBansView() {
  const { status } = useAdminGate(REQUIRED);

  return (
    <AdminPanel status={status}>
      <section className="flex-1 p-4 sm:p-8">
        <h1 className="mb-2 text-2xl font-semibold">Bans & Mutes</h1>
        <p className="mb-6 text-sm text-muted">Active sanctions. Lift them to restore access.</p>
        <BansPanel />
      </section>
    </AdminPanel>
  );
}
