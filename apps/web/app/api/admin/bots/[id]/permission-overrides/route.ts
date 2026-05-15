import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { principalPermissionOverrides } from "@legends/db/schema";
import { PERMISSIONS, isValidPermission, isValidEffect } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor?.permissions.has(PERMISSIONS.BOTS_MANAGE)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const rows = await db.select().from(principalPermissionOverrides).where(
    and(eq(principalPermissionOverrides.principalType, "bot"), eq(principalPermissionOverrides.principalId, id)),
  );
  return NextResponse.json({ overrides: rows });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor?.permissions.has(PERMISSIONS.BOTS_MANAGE)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json() as { permission: string; effect: string; expiresAt?: string | null };
  if (!body.permission || !body.effect) return NextResponse.json({ error: "permission and effect required" }, { status: 400 });
  if (!isValidPermission(body.permission)) return NextResponse.json({ error: `unknown permission '${body.permission}'` }, { status: 400 });
  if (!isValidEffect(body.effect)) return NextResponse.json({ error: "effect must be 'allow' or 'deny'" }, { status: 400 });
  const [override] = await db
    .insert(principalPermissionOverrides)
    .values({ principalType: "bot", principalId: id, permission: body.permission, effect: body.effect, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, grantedBy: actor.id })
    .onConflictDoUpdate({
      target: [principalPermissionOverrides.principalType, principalPermissionOverrides.principalId, principalPermissionOverrides.permission],
      set: { effect: body.effect, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, grantedBy: actor.id, grantedAt: new Date() },
    })
    .returning();
  return NextResponse.json({ override });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor?.permissions.has(PERMISSIONS.BOTS_MANAGE)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json() as { permission: string };
  if (!body.permission) return NextResponse.json({ error: "permission required" }, { status: 400 });
  await db.delete(principalPermissionOverrides).where(
    and(eq(principalPermissionOverrides.principalType, "bot"), eq(principalPermissionOverrides.principalId, id), eq(principalPermissionOverrides.permission, body.permission)),
  );
  return NextResponse.json({ ok: true });
}
