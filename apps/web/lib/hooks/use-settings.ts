"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/fetch";

export interface SettingsPayload {
  currentTheme: string;
  currentCompact: string;
}

export type SettingsStatus = "loading" | "ready" | "unauthenticated" | "error";

export function useSettings(): { data: SettingsPayload | null; status: SettingsStatus } {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [status, setStatus] = useState<SettingsStatus>("loading");

  useEffect(() => {
    let mounted = true;
    apiFetch("/api/settings/me")
      .then(async (r) => {
        if (!mounted) return;
        if (r.status === 401) { setStatus("unauthenticated"); return; }
        if (!r.ok) throw new Error(`/api/settings/me ${r.status}`);
        const j = (await r.json()) as SettingsPayload;
        setData(j);
        setStatus("ready");
      })
      .catch(() => mounted && setStatus("error"));
    return () => { mounted = false; };
  }, []);

  return { data, status };
}
