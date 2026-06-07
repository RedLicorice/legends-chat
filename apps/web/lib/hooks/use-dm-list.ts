"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/fetch";

export interface DmListConversation {
  id: string;
  state: "pending" | "accepted" | "blocked";
  isE2ee: boolean;
  e2eeRoomId: string | null;
  peer: {
    type: "user" | "bot";
    id: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
  lastMessageAt: string | null;
  incoming: boolean;
}

export interface DmListPayload {
  conversations: DmListConversation[];
}

export type DmListStatus = "loading" | "ready" | "unauthenticated" | "error";

export function useDmList(): { data: DmListPayload | null; status: DmListStatus } {
  const [data, setData] = useState<DmListPayload | null>(null);
  const [status, setStatus] = useState<DmListStatus>("loading");

  useEffect(() => {
    let mounted = true;
    apiFetch("/api/dm")
      .then(async (r) => {
        if (!mounted) return;
        if (r.status === 401) { setStatus("unauthenticated"); return; }
        if (!r.ok) throw new Error(`/api/dm ${r.status}`);
        const j = (await r.json()) as DmListPayload;
        setData(j);
        setStatus("ready");
      })
      .catch(() => mounted && setStatus("error"));
    return () => { mounted = false; };
  }, []);

  return { data, status };
}
