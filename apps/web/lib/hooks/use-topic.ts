"use client";

import { useApiResource } from "@/lib/hooks/use-api-resource";

export interface TopicPayload {
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
  canPost: boolean;
  canReply: boolean;
}

export function useTopic(slug: string | undefined) {
  return useApiResource<TopicPayload>(slug ? `/api/topic/${encodeURIComponent(slug)}` : null);
}
