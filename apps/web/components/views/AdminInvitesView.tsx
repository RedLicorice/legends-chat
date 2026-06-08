"use client";

import { useEffect } from "react";
import { PWASplash } from "@/components/PWASplash";
import { InvitesPanel } from "@/components/InvitesPanel";
import { useAdminGate } from "@/lib/hooks/use-admin-gate";

const REQUIRED = ["invites.create"];
const ELEVATED = "invites.create.elevated";

export function AdminInvitesView() {
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
      <h1 className="mb-1 text-2xl font-semibold">Invites</h1>
      <p className="mb-6 text-sm text-muted">
        Generate invite codes for new members. Codes look like{" "}
        <code className="text-accent">LGND#XXXXXX</code>.
      </p>
      <InvitesPanel canCreateElevated={me.permissions.includes(ELEVATED)} />
    </main>
  );
}
