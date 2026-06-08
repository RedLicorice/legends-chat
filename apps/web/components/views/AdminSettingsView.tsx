"use client";

import { useEffect } from "react";
import { PWASplash } from "@/components/PWASplash";
import { AdminSettingsForm } from "@/components/AdminSettingsForm";
import { useAdminSettings } from "@/lib/hooks/use-admin-settings";

export function AdminSettingsView() {
  const { data, status } = useAdminSettings();

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
        <p className="text-sm text-muted">Failed to load settings. Try refreshing.</p>
      </main>
    );
  }

  // AdminSettingsForm expects Record<string, string>; coerce null → "".
  const settings = Object.fromEntries(
    Object.entries(data.settings).map(([k, v]) => [k, v ?? ""]),
  ) as Record<string, string>;

  return (
    <main className="flex-1 p-8 max-w-xl">
      <h1 className="mb-2 text-2xl font-semibold">Community Settings</h1>
      <p className="mb-6 text-sm text-muted">Configure the default channel and automated system messages.</p>
      <AdminSettingsForm settings={settings} topics={data.topics} />
    </main>
  );
}
