"use client";

import { AdminPanel } from "@/components/views/AdminPanel";
import { AdminSettingsForm } from "@/components/AdminSettingsForm";
import { useAdminSettings } from "@/lib/hooks/use-admin-settings";

export function AdminSettingsView() {
  const { data, status } = useAdminSettings();

  const settings = data
    ? (Object.fromEntries(
        Object.entries(data.settings).map(([k, v]) => [k, v ?? ""]),
      ) as Record<string, string>)
    : null;

  return (
    <AdminPanel status={status} errorMessage="Failed to load settings. Try refreshing.">
      {data && settings && (
        <main className="flex-1 p-8 max-w-xl">
          <h1 className="mb-2 text-2xl font-semibold">Community Settings</h1>
          <p className="mb-6 text-sm text-muted">Configure the default channel and automated system messages.</p>
          <AdminSettingsForm settings={settings} topics={data.topics} />
        </main>
      )}
    </AdminPanel>
  );
}
