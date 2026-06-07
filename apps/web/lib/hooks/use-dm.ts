"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/fetch";
import type { ChatItem } from "@/components/ChatListItem";

export interface DmPayload {
  user: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    role: string;
    permissions: string[];
    presenceOptOut: boolean;
  };
  chatItems: ChatItem[];
  conversation: {
    id: string;
    isE2ee: boolean;
    e2eeRoomId: string | null;
    state: "pending" | "accepted" | "blocked";
    peer: {
      type: "user" | "bot";
      id: string;
      displayName: string;
      avatarUrl: string | null;
    } | null;
  };
}

export type DmStatus =
  | "loading"
  | "ready"
  | "unauthenticated"
  | "notFound"
  | "error";

export function useDm(id: string | undefined): { data: DmPayload | null; status: DmStatus } {
  const [data, setData] = useState<DmPayload | null>(null);
  const [status, setStatus] = useState<DmStatus>("loading");

  useEffect(() => {
    if (!id) return;
    let mounted = true;
    setStatus("loading");
    setData(null);
    apiFetch(`/api/dm/${encodeURIComponent(id)}`)
      .then(async (r) => {
        if (!mounted) return;
        if (r.status === 401) { setStatus("unauthenticated"); return; }
        if (r.status === 404) { setStatus("notFound"); return; }
        if (!r.ok) throw new Error(`/api/dm/${id} ${r.status}`);
        const j = (await r.json()) as DmPayload;
        setData(j);
        setStatus("ready");
      })
      .catch(() => mounted && setStatus("error"));
    return () => { mounted = false; };
  }, [id]);

  return { data, status };
}
