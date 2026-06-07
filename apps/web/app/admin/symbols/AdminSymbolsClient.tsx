"use client";

import { useEffect } from "react";
import { PWASplash } from "@/components/PWASplash";
import { AdminSymbolsPanel } from "@/components/AdminSymbolsPanel";
import { useAdminGate } from "@/lib/hooks/use-admin-gate";

const REQUIRED = ["admin.config"];

export function AdminSymbolsClient() {
  const { status } = useAdminGate(REQUIRED);

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
  if (status === "error") {
    return (
      <main className="flex-1 p-8">
        <p className="text-sm text-muted">Failed to load. Try refreshing.</p>
      </main>
    );
  }

  return (
    <main className="flex-1 p-4 sm:p-8">
      <h1 className="mb-2 text-2xl font-semibold">Symbols</h1>
      <p className="mb-6 text-sm text-muted">Define $ticker symbols and link them to vendor users.</p>
      <AdminSymbolsPanel />
    </main>
  );
}
