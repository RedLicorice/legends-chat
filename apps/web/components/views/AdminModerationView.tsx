"use client";

import { useEffect } from "react";
import { PWASplash } from "@/components/PWASplash";
import { ModerationQueue } from "@/components/ModerationQueue";
import { useAdminModeration } from "@/lib/hooks/use-admin-moderation";

export function AdminModerationView() {
  const { data, status } = useAdminModeration();

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
        <p className="text-sm text-muted">Failed to load moderation queue. Try refreshing.</p>
      </main>
    );
  }

  return (
    <main className="flex-1 p-4 sm:p-8">
      <h1 className="mb-2 text-2xl font-semibold">Moderation queue</h1>
      <p className="mb-6 text-sm text-muted">
        {data.flags.length} pending flag{data.flags.length === 1 ? "" : "s"}
      </p>
      <ModerationQueue flags={data.flags} canBan={data.canBan} canMute={data.canMute} />
    </main>
  );
}
