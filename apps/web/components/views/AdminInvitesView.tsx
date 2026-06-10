"use client";

import { AdminPanel } from "@/components/views/AdminPanel";
import { InvitesPanel } from "@/components/InvitesPanel";
import { useAdminGate } from "@/lib/hooks/use-admin-gate";

const REQUIRED = ["invites.create"];
const ELEVATED = "invites.create.elevated";

export function AdminInvitesView() {
  const { status, me } = useAdminGate(REQUIRED);

  return (
    <AdminPanel status={status}>
      {me && (
        <section className="flex-1 p-4 sm:p-8">
          <h1 className="mb-1 text-2xl font-semibold">Invites</h1>
          <p className="mb-6 text-sm text-muted">
            Generate invite codes for new members. Codes look like{" "}
            <code className="text-accent">LGND#XXXXXX</code>.
          </p>
          <InvitesPanel canCreateElevated={me.permissions.includes(ELEVATED)} />
        </section>
      )}
    </AdminPanel>
  );
}
