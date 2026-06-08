"use client";

import { useApiResource } from "@/lib/hooks/use-api-resource";

export interface AdminBotsPayload {
  bots: {
    id: string;
    name: string;
    avatarUrl: string | null;
    description: string | null;
    webhookUrl: string | null;
    isActive: boolean;
    createdAt: string;
    role: string;
    roleExpiresAt: string | null;
    roleFallback: string | null;
  }[];
  topics: { id: string; title: string; isE2ee: boolean }[];
  assignments: { botId: string; topicId: string }[];
}

export function useAdminBots() {
  return useApiResource<AdminBotsPayload>("/api/admin/bots/page-data");
}
