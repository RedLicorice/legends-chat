"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/fetch";
import type { ChatItem } from "@/components/ChatListItem";

export interface BannerConfig {
  url: string;
  height: number;
  overlap: number;
  overlayEnabled: boolean;
  overlayOpacity: number;
  fadeEnabled: boolean;
}

export interface ChatListPayload {
  homeTopicSlug: string | null;
  chatItems: ChatItem[];
  communityName: string;
  communityBannerUrl: string | null;
  bannerConfig: BannerConfig | null;
}

export type ChatListStatus = "loading" | "ready" | "unauthenticated" | "error";

export function useChatList(): { data: ChatListPayload | null; status: ChatListStatus } {
  const [data, setData] = useState<ChatListPayload | null>(null);
  const [status, setStatus] = useState<ChatListStatus>("loading");

  useEffect(() => {
    let mounted = true;
    apiFetch("/api/chat-list")
      .then(async (r) => {
        if (!mounted) return;
        if (r.status === 401) { setStatus("unauthenticated"); return; }
        if (!r.ok) throw new Error(`/api/chat-list ${r.status}`);
        const j = (await r.json()) as ChatListPayload;
        setData(j);
        setStatus("ready");
      })
      .catch(() => mounted && setStatus("error"));
    return () => { mounted = false; };
  }, []);

  return { data, status };
}
