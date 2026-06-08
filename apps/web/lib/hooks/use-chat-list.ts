"use client";

import { useApiResource } from "@/lib/hooks/use-api-resource";
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

export function useChatList() {
  return useApiResource<ChatListPayload>("/api/chat-list");
}
