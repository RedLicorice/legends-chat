"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { PWASplash } from "@/components/PWASplash";
import { useMe } from "@/lib/hooks/use-me";

/**
 * Legacy `/dm` route. The DM list now lives in the unified left sidebar on
 * `/`, so we redirect to the home page with the `dms` filter chip preselected.
 * The legacy `?tab=bots` query param maps to `?filter=bots` for parity.
 *
 * Auth is still required because `/login` should win over showing the home
 * filter chip — we wait for /api/me before deciding, just like the old SSR
 * page did via getCurrentUser + redirect("/login").
 */
export function DMListClient() {
  const { status: meStatus } = useMe();
  const searchParams = useSearchParams();
  const tab = searchParams?.get("tab") ?? null;

  useEffect(() => {
    if (meStatus === "unauthenticated") {
      window.location.replace("/login");
      return;
    }
    if (meStatus === "authenticated") {
      const target = tab === "bots" ? "/?filter=bots" : "/?filter=dms";
      window.location.replace(target);
    }
  }, [meStatus, tab]);

  return <PWASplash />;
}
