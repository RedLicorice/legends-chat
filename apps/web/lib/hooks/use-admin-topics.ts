"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/fetch";

export interface AdminTopicRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  isSticky: boolean;
  sortOrder: number;
  isFeed: boolean;
  isHomeTopic: boolean;
  isE2ee: boolean;
  isP2p: boolean;
  p2pFallbackE2ee: boolean;
  p2pMaxParticipants: number | null;
  viewRoles: string[];
  postRoles: string[];
  readRoles: string[];
  replyRoles: string[];
  autoDeleteMode: "none" | "age" | "count";
  autoDeleteAgeSeconds: number | null;
  autoDeleteMaxMessages: number | null;
  passwordProtected: boolean;
  passwordVersion: number;
  passwordReentryDays: number;
}

export interface AdminTopicsPayload {
  topics: AdminTopicRow[];
}

export type AdminTopicsStatus =
  | "loading"
  | "ready"
  | "unauthenticated"
  | "forbidden"
  | "error";

export function useAdminTopics(): {
  data: AdminTopicsPayload | null;
  status: AdminTopicsStatus;
} {
  const [data, setData] = useState<AdminTopicsPayload | null>(null);
  const [status, setStatus] = useState<AdminTopicsStatus>("loading");

  useEffect(() => {
    let mounted = true;
    apiFetch("/api/admin/topics/page-data")
      .then(async (r) => {
        if (!mounted) return;
        if (r.status === 401) { setStatus("unauthenticated"); return; }
        if (r.status === 403) { setStatus("forbidden"); return; }
        if (!r.ok) throw new Error(`/api/admin/topics/page-data ${r.status}`);
        setData((await r.json()) as AdminTopicsPayload);
        setStatus("ready");
      })
      .catch(() => mounted && setStatus("error"));
    return () => { mounted = false; };
  }, []);

  return { data, status };
}
