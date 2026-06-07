"use client";

import { useEffect } from "react";
import { PWASplash } from "@/components/PWASplash";
import { AdminThemesForm } from "@/components/AdminThemesForm";
import { useAdminThemes } from "@/lib/hooks/use-admin-themes";

export function AdminThemesClient() {
  const { data, status } = useAdminThemes();

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
        <p className="text-sm text-muted">Failed to load themes. Try refreshing.</p>
      </main>
    );
  }

  return (
    <main className="flex-1 p-4 sm:p-8">
      <h1 className="mb-2 text-2xl font-semibold">Themes</h1>
      <p className="mb-6 text-sm text-muted">
        Create and edit themes. Users can pick any theme in their settings; the default applies to everyone else.
      </p>
      <AdminThemesForm themes={data.themes} defaultTheme={data.defaultTheme} />
    </main>
  );
}
