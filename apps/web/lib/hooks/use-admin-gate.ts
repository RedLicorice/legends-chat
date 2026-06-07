"use client";

import { useMe } from "@/lib/hooks/use-me";

export type AdminGateStatus =
  | "loading"
  | "ready"
  | "unauthenticated"
  | "forbidden"
  | "error";

/**
 * Client-side admin gate. Calls /api/me via useMe() and checks whether the
 * caller holds at least one of the required permissions. Returns a status the
 * shell client component can switch on.
 *
 * Server enforcement still happens at the per-action API routes — this hook
 * is purely UX: avoid rendering the admin panel for users who'd 403 anyway.
 */
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
