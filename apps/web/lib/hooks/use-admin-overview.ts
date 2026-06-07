"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/fetch";

export interface AdminOverviewPayload {
  pendingFlags: number;
  newUsers24h: number;
  newUsers7d: number;
  onlineNow: number;
  topicActivity: { id: string; title: string; messages24h: number; messages7d: number }[];
}

export type AdminOverviewStatus =
  | "loading"
  | "ready"
  | "unauthenticated"
  | "forbidden"
  | "error";

export function useAdminOverview(): {
  data: AdminOverviewPayload | null;
  status: AdminOverviewStatus;
} {
  const [data, setData] = useState<AdminOverviewPayload | null>(null);
  const [status, setStatus] = useState<AdminOverviewStatus>("loading");

  useEffect(() => {
    let mounted = true;
    apiFetch("/api/admin/overview")
      .then(async (r) => {
        if (!mounted) return;
        if (r.status === 401) { setStatus("unauthenticated"); return; }
        if (r.status === 403) { setStatus("forbidden"); return; }
        if (!r.ok) throw new Error(`/api/admin/overview ${r.status}`);
        setData((await r.json()) as AdminOverviewPayload);
        setStatus("ready");
      })
      .catch(() => mounted && setStatus("error"));
    return () => { mounted = false; };
  }, []);

  return { data, status };
}
