"use client";

import { useApiResource } from "@/lib/hooks/use-api-resource";
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
    /** true when the current user is the recipient of a pending request. */
    incoming: boolean;
    peer: {
      type: "user" | "bot";
      id: string;
      displayName: string;
      avatarUrl: string | null;
    } | null;
  };
}

export function useDm(id: string | undefined) {
  return useApiResource<DmPayload>(id ? `/api/dm/${encodeURIComponent(id)}` : null);
}
