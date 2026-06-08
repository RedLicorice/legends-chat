"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { PWASplash } from "@/components/PWASplash";
import { AdminTopicsForm } from "@/components/AdminTopicsForm";
import { useAdminTopics } from "@/lib/hooks/use-admin-topics";

export function AdminTopicsView() {
  const { data, status } = useAdminTopics();
  const searchParams = useSearchParams();
  const initialSelected = searchParams?.get("select") ?? undefined;

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
        <p className="text-sm text-muted">Failed to load topics. Try refreshing.</p>
      </main>
    );
  }

  return (
    <main className="flex-1 p-4 sm:p-8">
      <h1 className="mb-2 text-2xl font-semibold">Topics</h1>
      <p className="mb-6 text-sm text-muted">Configure feed mode, home topic, and post permissions.</p>
      <AdminTopicsForm initialSelected={initialSelected} topics={data.topics} />
    </main>
  );
}
