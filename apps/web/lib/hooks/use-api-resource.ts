"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/fetch";

export type ResourceStatus =
  | "loading"
  | "ready"
  | "unauthenticated"
  | "notFound"
  | "forbidden"
  | "error";

export function useApiResource<T>(
  path: string | null | undefined,
): { data: T | null; status: ResourceStatus } {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<ResourceStatus>("loading");

  useEffect(() => {
    if (!path) return;
    let mounted = true;
    setStatus("loading");
    apiFetch(path)
      .then(async (r) => {
        if (!mounted) return;
        if (r.status === 401) { setData(null); setStatus("unauthenticated"); return; }
        if (r.status === 403) { setData(null); setStatus("forbidden"); return; }
        if (r.status === 404) { setData(null); setStatus("notFound"); return; }
        if (!r.ok) throw new Error(`${path} ${r.status}`);
        setData((await r.json()) as T);
        setStatus("ready");
      })
      .catch(() => mounted && setStatus("error"));
    return () => { mounted = false; };
  }, [path]);

  return { data, status };
}
