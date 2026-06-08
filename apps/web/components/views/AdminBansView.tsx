"use client";

import { useEffect } from "react";
import { PWASplash } from "@/components/PWASplash";
import { BansPanel } from "@/components/BansPanel";
import { useAdminGate } from "@/lib/hooks/use-admin-gate";

const REQUIRED = ["admin.config"];

export function AdminBansView() {
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
    <main className="flex-1 p-8 max-w-3xl">
      <h1 className="mb-2 text-2xl font-semibold">Bans & Mutes</h1>
      <p className="mb-6 text-sm text-muted">Active sanctions. Lift them to restore access.</p>
      <BansPanel />
    </main>
  );
}
