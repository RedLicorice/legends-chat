"use client";

import { useApiResource } from "@/lib/hooks/use-api-resource";

export interface AdminRoleRow {
  name: string;
  label: string;
  isSystem: boolean;
  sortOrder: number;
  permissions: string[];
}

export function useAdminRoles() {
  return useApiResource<AdminRoleRow[]>("/api/admin/roles");
}
