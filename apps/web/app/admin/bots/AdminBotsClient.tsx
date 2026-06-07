"use client";

import { useEffect } from "react";
import { PWASplash } from "@/components/PWASplash";
import { AdminBotsForm } from "@/components/AdminBotsForm";
import { useAdminBots } from "@/lib/hooks/use-admin-bots";

export function AdminBotsClient() {
  const { data, status } = useAdminBots();

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
        <p className="text-sm text-muted">Failed to load bots. Try refreshing.</p>
      </main>
    );
  }

  return (
    <main className="flex-1 p-4 sm:p-8">
      <h1 className="mb-2 text-2xl font-semibold">Bots</h1>
      <p className="mb-6 text-sm text-muted">Create and manage bots. Assign them to topics to receive message webhooks.</p>
      <AdminBotsForm
        bots={data.bots}
        topics={data.topics}
        assignments={data.assignments}
      />
    </main>
  );
}
