"use client";

import { useEffect } from "react";
import { AppShellMobileBar } from "@/components/AppShell";
import { PWASplash } from "@/components/PWASplash";
import type { ResourceStatus } from "@/lib/hooks/use-api-resource";

export function AdminPanel({
  status,
  hasData = false,
  errorMessage = "Failed to load. Try refreshing.",
  forbiddenMessage = "You don't have permission to view this page.",
  children,
}: {
  status: ResourceStatus;
  // Pass true when the caller has prior data from a previous nav. Lets us
  // skip the splash on re-fetch (stale-while-revalidate) so the UI never
  // flashes black between routes.
  hasData?: boolean;
  errorMessage?: string;
  forbiddenMessage?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (status === "unauthenticated") window.location.replace("/login");
  }, [status]);

  if (status === "forbidden") {
    return (
      <>
        <AppShellMobileBar />
        <section className="flex-1 p-4 sm:p-8">
          <p className="text-sm text-muted">{forbiddenMessage}</p>
        </section>
      </>
    );
  }
  if (status === "error" && !hasData) {
    return (
      <>
        <AppShellMobileBar />
        <section className="flex-1 p-4 sm:p-8">
          <p className="text-sm text-muted">{errorMessage}</p>
        </section>
      </>
    );
  }
  // Splash only on FIRST load — once we have prior data OR the request is
  // ready, render children (lets gate-only views drop the splash even
  // without a data payload, and lets data views serve stale-while-revalidate).
  if (status === "loading" && !hasData) return <PWASplash />;
  if (status === "unauthenticated") return <PWASplash />;
  return (
    <>
      <AppShellMobileBar />
      {children}
    </>
  );
}
