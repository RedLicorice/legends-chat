"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/fetch";

export interface AdminSettingsPayload {
  settings: Record<string, string | null>;
  topics: { id: string; title: string; slug: string }[];
}

export type AdminSettingsStatus =
  | "loading"
  | "ready"
  | "unauthenticated"
  | "forbidden"
  | "error";

export function useAdminSettings(): {
  data: AdminSettingsPayload | null;
  status: AdminSettingsStatus;
} {
  const [data, setData] = useState<AdminSettingsPayload | null>(null);
  const [status, setStatus] = useState<AdminSettingsStatus>("loading");

  useEffect(() => {
    let mounted = true;
    apiFetch("/api/admin/settings")
      .then(async (r) => {
        if (!mounted) return;
        if (r.status === 401) { setStatus("unauthenticated"); return; }
        if (r.status === 403) { setStatus("forbidden"); return; }
        if (!r.ok) throw new Error(`/api/admin/settings ${r.status}`);
        setData((await r.json()) as AdminSettingsPayload);
        setStatus("ready");
      })
      .catch(() => mounted && setStatus("error"));
    return () => { mounted = false; };
  }, []);

  return { data, status };
}
