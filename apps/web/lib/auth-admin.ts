import { NextResponse } from "next/server";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser, type CurrentUser } from "@/lib/auth";

/**
 * Gate for admin API routes that previously redirected non-admin users to `/`.
 * Returns the current user on success, or a NextResponse (401/403) the route
 * should `return` directly.
 *
 * Pass an explicit `requiredPermission` if the route's original page checked
 * a permission other than ADMIN_CONFIG (e.g. BOTS_MANAGE, INVITES_CREATE,
 * MODERATION_QUEUE_REVIEW, USERS_BAN_DIRECT).
 */
export async function requireAdmin(
  requiredPermission: string = PERMISSIONS.ADMIN_CONFIG,
): Promise<CurrentUser | NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!user.permissions.has(requiredPermission)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return user;
}

/**
 * Same as requireAdmin but accepts multiple permissions (OR). Used by the
 * overview / dashboard endpoints whose page allowed either MODERATION_QUEUE_REVIEW
 * or ADMIN_CONFIG.
 */
export async function requireAnyAdmin(
  permissions: string[],
): Promise<CurrentUser | NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!permissions.some((p) => user.permissions.has(p))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return user;
}
