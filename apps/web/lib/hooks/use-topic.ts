"use client";

import { useApiResource } from "@/lib/hooks/use-api-resource";
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

export function useTopic(slug: string | undefined) {
  return useApiResource<TopicPayload>(slug ? `/api/topic/${encodeURIComponent(slug)}` : null);
}
