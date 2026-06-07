"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/fetch";

export interface AdminBotsPayload {
  bots: {
    id: string;
    name: string;
    avatarUrl: string | null;
    description: string | null;
    webhookUrl: string | null;
    isActive: boolean;
    createdAt: string;
    role: string;
    roleExpiresAt: string | null;
    roleFallback: string | null;
  }[];
  topics: { id: string; title: string; isE2ee: boolean }[];
  assignments: { botId: string; topicId: string }[];
}

export type AdminBotsStatus =
  | "loading"
  | "ready"
  | "unauthenticated"
  | "forbidden"
  | "error";

export function useAdminBots(): {
  data: AdminBotsPayload | null;
  status: AdminBotsStatus;
} {
  const [data, setData] = useState<AdminBotsPayload | null>(null);
  const [status, setStatus] = useState<AdminBotsStatus>("loading");

  useEffect(() => {
    let mounted = true;
    apiFetch("/api/admin/bots/page-data")
      .then(async (r) => {
        if (!mounted) return;
        if (r.status === 401) { setStatus("unauthenticated"); return; }
        if (r.status === 403) { setStatus("forbidden"); return; }
        if (!r.ok) throw new Error(`/api/admin/bots/page-data ${r.status}`);
        setData((await r.json()) as AdminBotsPayload);
        setStatus("ready");
      })
      .catch(() => mounted && setStatus("error"));
    return () => { mounted = false; };
  }, []);

  return { data, status };
}
