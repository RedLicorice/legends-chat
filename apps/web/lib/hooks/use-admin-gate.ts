"use client";

import { useMe } from "@/lib/hooks/use-me";

export type AdminGateStatus =
  | "loading"
  | "ready"
  | "unauthenticated"
  | "forbidden"
  | "error";

export function useAdminGate(requiredPermissions: string[]): {
  status: AdminGateStatus;
  me: ReturnType<typeof useMe>["me"];
} {
  const { me, status: meStatus } = useMe();

  if (meStatus === "loading") return { status: "loading", me };
  if (meStatus === "unauthenticated") return { status: "unauthenticated", me };
  if (meStatus === "error" || !me) return { status: "error", me };

  const ok = requiredPermissions.some((p) => me.permissions.includes(p));
  return { status: ok ? "ready" : "forbidden", me };
}
