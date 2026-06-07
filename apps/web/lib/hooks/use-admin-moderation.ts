"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/fetch";

export interface ModerationFlag {
  id: string;
  createdAt: string;
  reason: string;
  reporter: { id: string; displayName: string };
  message: {
    id: string;
    topicId: string;
    senderUserId: string | null;
    senderDisplayName: string | null;
    text: string;
    deletedAt: string | null;
  };
}

export interface AdminModerationPayload {
  flags: ModerationFlag[];
  canBan: boolean;
  canMute: boolean;
}

export type AdminModerationStatus =
  | "loading"
  | "ready"
  | "unauthenticated"
  | "forbidden"
  | "error";

export function useAdminModeration(): {
  data: AdminModerationPayload | null;
  status: AdminModerationStatus;
} {
  const [data, setData] = useState<AdminModerationPayload | null>(null);
  const [status, setStatus] = useState<AdminModerationStatus>("loading");

  useEffect(() => {
    let mounted = true;
    apiFetch("/api/admin/moderation/flags")
      .then(async (r) => {
        if (!mounted) return;
        if (r.status === 401) { setStatus("unauthenticated"); return; }
        if (r.status === 403) { setStatus("forbidden"); return; }
        if (!r.ok) throw new Error(`/api/admin/moderation/flags ${r.status}`);
        setData((await r.json()) as AdminModerationPayload);
        setStatus("ready");
      })
      .catch(() => mounted && setStatus("error"));
    return () => { mounted = false; };
  }, []);

  return { data, status };
}
