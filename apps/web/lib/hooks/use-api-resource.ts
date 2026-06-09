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

// Module-level cache so a revisit to the same endpoint shows the cached
// payload instantly, then refetches in the background (stale-while-revalidate).
// Single instance per Node/browser process — survives component remounts but
// not full page reloads.
const cache = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

async function fetchAndCache(path: string): Promise<unknown> {
  const ongoing = inflight.get(path);
  if (ongoing) return ongoing;
  const p = apiFetch(path)
    .then(async (r) => {
      if (r.status === 401) throw { kind: "unauthenticated" as const };
      if (r.status === 403) throw { kind: "forbidden" as const };
      if (r.status === 404) throw { kind: "notFound" as const };
      if (!r.ok) throw { kind: "error" as const, status: r.status };
      const j = await r.json();
      cache.set(path, j);
      return j;
    })
    .finally(() => inflight.delete(path));
  inflight.set(path, p);
  return p;
}

export function useApiResource<T>(
  path: string | null | undefined,
): { data: T | null; status: ResourceStatus } {
  const cached = path ? (cache.get(path) as T | undefined) : undefined;
  const [data, setData] = useState<T | null>(cached ?? null);
  const [status, setStatus] = useState<ResourceStatus>(cached ? "ready" : "loading");

  useEffect(() => {
    if (!path) {
      setData(null);
      setStatus("loading");
      return;
    }
    let mounted = true;
    const cachedNow = cache.get(path) as T | undefined;
    if (cachedNow !== undefined) {
      setData(cachedNow);
      setStatus("ready");
    } else {
      setStatus("loading");
    }
    fetchAndCache(path)
      .then((j) => {
        if (!mounted) return;
        setData(j as T);
        setStatus("ready");
      })
      .catch((err: { kind?: ResourceStatus }) => {
        if (!mounted) return;
        const k = err?.kind;
        if (k === "unauthenticated" || k === "forbidden" || k === "notFound") {
          setData(null);
          setStatus(k);
        } else {
          setStatus("error");
        }
      });
    return () => { mounted = false; };
  }, [path]);

  return { data, status };
}

// Public mutators so writes elsewhere can keep the cache fresh.
export function invalidateApiResource(path: string): void {
  cache.delete(path);
}
export function clearAllApiResources(): void {
  cache.clear();
}
