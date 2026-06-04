import { desc, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { passkeyCredentials, userBans, userMutes, users } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { logDeviceChange } from "@/lib/device-change-log";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor || !actor.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!u) return NextResponse.json({ error: "not found" }, { status: 404 });

  const now = new Date();
  const [passkeys, bansHistory, mutesHistory] = await Promise.all([
    db.select({ id: passkeyCredentials.id, name: passkeyCredentials.name, deviceType: passkeyCredentials.deviceType, createdAt: passkeyCredentials.createdAt })
      .from(passkeyCredentials).where(eq(passkeyCredentials.userId, id)).orderBy(desc(passkeyCredentials.createdAt)),
    db.select({ id: userBans.id, reason: userBans.reason, createdAt: userBans.createdAt, expiresAt: userBans.expiresAt, liftedAt: userBans.liftedAt })
      .from(userBans).where(eq(userBans.userId, id)).orderBy(desc(userBans.createdAt)).limit(10),
    db.select({ id: userMutes.id, reason: userMutes.reason, createdAt: userMutes.createdAt, expiresAt: userMutes.expiresAt, liftedAt: userMutes.liftedAt })
      .from(userMutes).where(eq(userMutes.userId, id)).orderBy(desc(userMutes.createdAt)).limit(10),
  ]);

  const activeBans = bansHistory.filter((b) => !b.liftedAt && (!b.expiresAt || b.expiresAt > now));
  const activeMutes = mutesHistory.filter((m) => !m.liftedAt && (!m.expiresAt || m.expiresAt > now));

  return NextResponse.json({
    id: u.id,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    bannerUrl: u.bannerUrl,
    role: u.role,
    roleExpiresAt: u.roleExpiresAt,
    roleFallback: u.roleFallback,
    email: u.email,
    telegramUsername: u.telegramUsername,
    isAnon: u.isAnon,
    presenceOptOut: u.presenceOptOut,
    createdAt: u.createdAt,
    passkeys,
    activeBans,
    activeMutes,
    bansHistory,
    mutesHistory,
  });
}

const patchSchema = z.object({
  role: z.enum(["user", "moderator", "admin"]).optional(),
  roleExpiresAt: z.string().nullable().optional(),
  roleFallback: z.string().nullable().optional(),
  displayName: z.string().min(1).max(64).optional(),
  email: z.string().email().nullable().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor || !actor.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Look up the previous role BEFORE the update so we can tell whether the
  // change crosses the admin boundary. E2EE topics auto-include admins in
  // the member set (see /api/crypto/rooms/[roomId]/members), so any admin
  // grant/revoke needs to invalidate device lists.
  const [prior] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  const patch: Record<string, unknown> = {};
  if (parsed.data.role !== undefined) patch.role = parsed.data.role;
  if ("roleExpiresAt" in parsed.data) patch.roleExpiresAt = parsed.data.roleExpiresAt ? new Date(parsed.data.roleExpiresAt) : null;
  if ("roleFallback" in parsed.data) patch.roleFallback = parsed.data.roleFallback ?? null;
  if (parsed.data.displayName !== undefined) patch.displayName = parsed.data.displayName;
  if ("email" in parsed.data) patch.email = parsed.data.email ?? null;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const [updated] = await db
    .update(users)
    .set(patch)
    .where(eq(users.id, id))
    .returning({ id: users.id });

  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (parsed.data.role !== undefined && prior) {
    const wasAdmin = prior.role === "admin";
    const isAdmin = parsed.data.role === "admin";
    if (wasAdmin !== isAdmin) {
      await logDeviceChange(id, isAdmin ? "admin_grant" : "admin_revoke");
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor || !actor.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;

  if (id === actor.id) {
    return NextResponse.json({ error: "cannot delete own account" }, { status: 400 });
  }

  await db.delete(users).where(eq(users.id, id));

  return NextResponse.json({ ok: true });
}
