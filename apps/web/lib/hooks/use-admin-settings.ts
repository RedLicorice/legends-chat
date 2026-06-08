"use client";

import { useApiResource } from "@/lib/hooks/use-api-resource";

export interface AdminSettingsPayload {
  settings: Record<string, string | null>;
  topics: { id: string; title: string; slug: string }[];
}

export function useAdminSettings() {
  return useApiResource<AdminSettingsPayload>("/api/admin/settings");
}
