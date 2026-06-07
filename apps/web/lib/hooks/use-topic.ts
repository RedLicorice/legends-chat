"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/fetch";
import type { ChatItem } from "@/components/ChatListItem";

export interface TopicPayload {
  user: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    role: string;
    permissions: string[];
    presenceOptOut: boolean;
  };
  chatItems: ChatItem[];
  topic: {
    id: string;
    slug: string;
    title: string;
    isE2ee: boolean;
    isP2p: boolean;
    p2pFallbackE2ee: boolean;
    isFeed: boolean;
    postRoles: string[];
    replyRoles: string[];
    iconUrl: string | null;
    bannerUrl: string | null;
    description: string | null;
    hasPassword: boolean;
    passwordVersion: number;
    passwordReentryDays: number;
  };
  mute: { reason: string; expiresAt: string | null } | null;
  hasPasskey: boolean;
  giphyEnabled: boolean;
  communityName: string | null;
  communityIconUrl: string | null;
  canPost: boolean;
  canReply: boolean;
}

export type TopicStatus = "loading" | "ready" | "unauthenticated" | "notFound" | "error";

export function useTopic(slug: string | undefined): { data: TopicPayload | null; status: TopicStatus } {
  const [data, setData] = useState<TopicPayload | null>(null);
  const [status, setStatus] = useState<TopicStatus>("loading");

  useEffect(() => {
    if (!slug) return;
    let mounted = true;
    setStatus("loading");
    setData(null);
    apiFetch(`/api/topic/${encodeURIComponent(slug)}`)
      .then(async (r) => {
        if (!mounted) return;
        if (r.status === 401) { setStatus("unauthenticated"); return; }
        if (r.status === 404) { setStatus("notFound"); return; }
        if (!r.ok) throw new Error(`/api/topic/${slug} ${r.status}`);
        const j = (await r.json()) as TopicPayload;
        setData(j);
        setStatus("ready");
      })
      .catch(() => mounted && setStatus("error"));
    return () => { mounted = false; };
  }, [slug]);

  return { data, status };
}
