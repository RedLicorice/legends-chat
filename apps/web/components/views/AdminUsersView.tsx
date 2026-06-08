"use client";

import { useEffect } from "react";
import { PWASplash } from "@/components/PWASplash";
import { AdminUsersForm } from "@/components/AdminUsersForm";
import { useAdminGate } from "@/lib/hooks/use-admin-gate";

const REQUIRED = ["admin.config"];

export function AdminUsersView() {
  const { status, me } = useAdminGate(REQUIRED);

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
  if (status === "error" || !me) {
    return (
      <main className="flex-1 p-8">
        <p className="text-sm text-muted">Failed to load. Try refreshing.</p>
      </main>
    );
  }

  return (
    <main className="flex-1 p-4 sm:p-8">
      <h1 className="mb-2 text-2xl font-semibold">Users</h1>
      <p className="mb-6 text-sm text-muted">Search members and change their roles.</p>
      <AdminUsersForm currentUserId={me.id} />
    </main>
  );
}
