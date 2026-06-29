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
    e2ee_state: "disabled" | "pending" | "ready";
    e2ee_device_id: string | null;
    identityKeyFingerprint?: string;
    lastKeysUploadAt?: string;
  }[];
  topics: { id: string; title: string; isE2ee: boolean }[];
  assignments: { botId: string; topicId: string }[];
  total: number;
}

export function useAdminBots() {
  return useApiResource<AdminBotsPayload>("/api/admin/bots/page-data");
}
