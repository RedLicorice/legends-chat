"use client";

import { AdminPanel } from "@/components/views/AdminPanel";
import { AdminSymbolsPanel } from "@/components/AdminSymbolsPanel";
import { useAdminGate } from "@/lib/hooks/use-admin-gate";

const REQUIRED = ["admin.config"];

export function AdminSymbolsView() {
  const { status } = useAdminGate(REQUIRED);

  return (
    <AdminPanel status={status}>
      <section className="flex-1 p-4 sm:p-8">
        <h1 className="mb-2 text-2xl font-semibold">Symbols</h1>
        <p className="mb-6 text-sm text-muted">Define $ticker symbols and link them to vendor users.</p>
        <AdminSymbolsPanel />
      </section>
    </AdminPanel>
  );
}
