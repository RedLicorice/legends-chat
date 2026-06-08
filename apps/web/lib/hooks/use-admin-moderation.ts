"use client";

import { useApiResource } from "@/lib/hooks/use-api-resource";

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

export function useAdminModeration() {
  return useApiResource<AdminModerationPayload>("/api/admin/moderation/flags");
}
