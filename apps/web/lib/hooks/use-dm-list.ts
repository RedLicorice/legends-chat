"use client";

import { useApiResource } from "@/lib/hooks/use-api-resource";

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

export function useDmList() {
  return useApiResource<DmListPayload>("/api/dm");
}
