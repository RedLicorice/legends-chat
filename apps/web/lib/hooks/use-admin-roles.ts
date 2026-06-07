"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/fetch";

export interface AdminRoleRow {
  name: string;
  label: string;
  isSystem: boolean;
  sortOrder: number;
  permissions: string[];
}

export type AdminRolesStatus =
  | "loading"
  | "ready"
  | "unauthenticated"
  | "forbidden"
  | "error";

export function useAdminRoles(): {
  data: AdminRoleRow[] | null;
  status: AdminRolesStatus;
} {
  const [data, setData] = useState<AdminRoleRow[] | null>(null);
  const [status, setStatus] = useState<AdminRolesStatus>("loading");

  useEffect(() => {
    let mounted = true;
    apiFetch("/api/admin/roles")
      .then(async (r) => {
        if (!mounted) return;
        if (r.status === 401) { setStatus("unauthenticated"); return; }
        if (r.status === 403) { setStatus("forbidden"); return; }
        if (!r.ok) throw new Error(`/api/admin/roles ${r.status}`);
        setData((await r.json()) as AdminRoleRow[]);
        setStatus("ready");
      })
      .catch(() => mounted && setStatus("error"));
    return () => { mounted = false; };
  }, []);

  return { data, status };
}
