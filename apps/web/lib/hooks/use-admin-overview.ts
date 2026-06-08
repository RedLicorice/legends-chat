"use client";

import { useApiResource } from "@/lib/hooks/use-api-resource";

export interface AdminOverviewPayload {
  pendingFlags: number;
  newUsers24h: number;
  newUsers7d: number;
  onlineNow: number;
  topicActivity: { id: string; title: string; messages24h: number; messages7d: number }[];
}

export function useAdminOverview() {
  return useApiResource<AdminOverviewPayload>("/api/admin/overview");
}
