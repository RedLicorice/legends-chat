"use client";

import { useSearchParams } from "next/navigation";
import { AdminPanel } from "@/components/views/AdminPanel";
import { AdminTopicsForm } from "@/components/AdminTopicsForm";
import { useAdminTopics } from "@/lib/hooks/use-admin-topics";

export function AdminTopicsView() {
  const { data, status } = useAdminTopics();
  const searchParams = useSearchParams();
  const initialSelected = searchParams?.get("select") ?? undefined;

  return (
    <AdminPanel status={status} hasData={!!data} errorMessage="Failed to load topics. Try refreshing.">
      {data && (
        <section className="flex-1 p-4 sm:p-8">
          <h1 className="mb-2 text-2xl font-semibold">Topics</h1>
          <p className="mb-6 text-sm text-muted">Configure feed mode, home topic, and post permissions.</p>
          <AdminTopicsForm initialSelected={initialSelected} topics={data.topics} />
        </section>
      )}
    </AdminPanel>
  );
}
