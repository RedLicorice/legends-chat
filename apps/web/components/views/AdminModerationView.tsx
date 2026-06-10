"use client";

import { AdminPanel } from "@/components/views/AdminPanel";
import { ModerationQueue } from "@/components/ModerationQueue";
import { useAdminModeration } from "@/lib/hooks/use-admin-moderation";

export function AdminModerationView() {
  const { data, status } = useAdminModeration();

  return (
    <AdminPanel status={status} hasData={!!data} errorMessage="Failed to load moderation queue. Try refreshing.">
      {data && (
        <section className="flex-1 p-4 sm:p-8">
          <h1 className="mb-2 text-2xl font-semibold">Moderation queue</h1>
          <p className="mb-6 text-sm text-muted">
            {data.flags.length} pending flag{data.flags.length === 1 ? "" : "s"}
          </p>
          <ModerationQueue flags={data.flags} canBan={data.canBan} canMute={data.canMute} />
        </section>
      )}
    </AdminPanel>
  );
}
