"use client";

import { useEffect } from "react";
import { PWASplash } from "@/components/PWASplash";
import type { ResourceStatus } from "@/lib/hooks/use-api-resource";

export function AdminPanel({
  status,
  errorMessage = "Failed to load. Try refreshing.",
  forbiddenMessage = "You don't have permission to view this page.",
  children,
}: {
  status: ResourceStatus;
  errorMessage?: string;
  forbiddenMessage?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (status === "unauthenticated") window.location.replace("/login");
  }, [status]);

  if (status === "loading" || status === "unauthenticated") return <PWASplash />;
  if (status === "forbidden") {
    return (
      <main className="flex-1 p-8">
        <p className="text-sm text-muted">{forbiddenMessage}</p>
      </main>
    );
  }
  if (status === "error") {
    return (
      <main className="flex-1 p-8">
        <p className="text-sm text-muted">{errorMessage}</p>
      </main>
    );
  }
  return <>{children}</>;
}
