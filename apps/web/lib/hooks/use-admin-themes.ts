"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/fetch";

export interface AdminThemeRow {
  id: string;
  name: string;
  isBuiltin: boolean;
  colors: Record<string, string>;
  isGlass: boolean;
  bgGradient: string;
  customCss: string | null;
}

export interface AdminThemesPayload {
  themes: AdminThemeRow[];
  defaultTheme: string;
}

export type AdminThemesStatus =
  | "loading"
  | "ready"
  | "unauthenticated"
  | "forbidden"
  | "error";

export function useAdminThemes(): {
  data: AdminThemesPayload | null;
  status: AdminThemesStatus;
} {
  const [data, setData] = useState<AdminThemesPayload | null>(null);
  const [status, setStatus] = useState<AdminThemesStatus>("loading");

  useEffect(() => {
    let mounted = true;
    apiFetch("/api/admin/themes/page-data")
      .then(async (r) => {
        if (!mounted) return;
        if (r.status === 401) { setStatus("unauthenticated"); return; }
        if (r.status === 403) { setStatus("forbidden"); return; }
        if (!r.ok) throw new Error(`/api/admin/themes/page-data ${r.status}`);
        setData((await r.json()) as AdminThemesPayload);
        setStatus("ready");
      })
      .catch(() => mounted && setStatus("error"));
    return () => { mounted = false; };
  }, []);

  return { data, status };
}
