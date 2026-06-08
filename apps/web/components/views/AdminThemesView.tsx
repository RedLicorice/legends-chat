"use client";

import { AdminPanel } from "@/components/views/AdminPanel";
import { AdminThemesForm } from "@/components/AdminThemesForm";
import { useAdminThemes } from "@/lib/hooks/use-admin-themes";

export function AdminThemesView() {
  const { data, status } = useAdminThemes();

  return (
    <AdminPanel status={status} errorMessage="Failed to load themes. Try refreshing.">
      {data && (
        <main className="flex-1 p-4 sm:p-8">
          <h1 className="mb-2 text-2xl font-semibold">Themes</h1>
          <p className="mb-6 text-sm text-muted">
            Create and edit themes. Users can pick any theme in their settings; the default applies to everyone else.
          </p>
          <AdminThemesForm themes={data.themes} defaultTheme={data.defaultTheme} />
        </main>
      )}
    </AdminPanel>
  );
}
