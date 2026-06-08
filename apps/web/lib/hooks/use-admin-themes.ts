"use client";

import { useApiResource } from "@/lib/hooks/use-api-resource";

export interface AdminThemeRow {
  id: string;
  name: string;
  isBuiltin: boolean;
  colors: Record<string, string>;
  isGlass: boolean;
  bgGradient: string;
  customCss: string | null;
}

export interface AdminThemesPayload {
  themes: AdminThemeRow[];
  defaultTheme: string;
}

export function useAdminThemes() {
  return useApiResource<AdminThemesPayload>("/api/admin/themes/page-data");
}
