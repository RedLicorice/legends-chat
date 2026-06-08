"use client";

import { useApiResource } from "@/lib/hooks/use-api-resource";

export interface SettingsPayload {
  currentTheme: string;
  currentCompact: string;
}

export function useSettings() {
  return useApiResource<SettingsPayload>("/api/settings/me");
}
