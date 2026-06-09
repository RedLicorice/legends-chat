"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/fetch";

export interface MeShape {
  id: string;
  role: string;
  permissions: string[];
  displayName: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  email: string | null;
  bio: string | null;
  isAnon: boolean;
  presenceOptOut: boolean;
}

export type MeStatus = "loading" | "authenticated" | "unauthenticated" | "error";

let cached: MeShape | null = null;
let inflight: Promise<MeShape | null> | null = null;

function fetchMe(): Promise<MeShape | null> {
  if (inflight) return inflight;
  inflight = apiFetch("/api/me")
    .then(async (r) => {
      if (r.status === 401) return null;
      if (!r.ok) throw new Error(`/api/me ${r.status}`);
      const j = (await r.json()) as MeShape;
      cached = j;
      return j;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useMe(): { me: MeShape | null; status: MeStatus } {
  const [me, setMe] = useState<MeShape | null>(cached);
  const [status, setStatus] = useState<MeStatus>(cached ? "authenticated" : "loading");

  useEffect(() => {
    let mounted = true;
    fetchMe()
      .then((value) => {
        if (!mounted) return;
        if (value === null) {
          setStatus("unauthenticated");
        } else {
          setMe(value);
          setStatus("authenticated");
        }
      })
      .catch(() => mounted && setStatus("error"));
    return () => { mounted = false; };
  }, []);

  return { me, status };
}
