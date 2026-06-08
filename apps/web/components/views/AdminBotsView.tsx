"use client";

import { AdminPanel } from "@/components/views/AdminPanel";
import { AdminBotsForm } from "@/components/AdminBotsForm";
import { useAdminBots } from "@/lib/hooks/use-admin-bots";

export function AdminBotsView() {
  const { data, status } = useAdminBots();

  return (
    <AdminPanel status={status} hasData={!!data} errorMessage="Failed to load bots. Try refreshing.">
      {data && (
        <main className="flex-1 p-4 sm:p-8">
          <h1 className="mb-2 text-2xl font-semibold">Bots</h1>
          <p className="mb-6 text-sm text-muted">Create and manage bots. Assign them to topics to receive message webhooks.</p>
          <AdminBotsForm
            bots={data.bots}
            topics={data.topics}
            assignments={data.assignments}
          />
        </main>
      )}
    </AdminPanel>
  );
}
