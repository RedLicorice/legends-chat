import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { PERMISSIONS } from "@legends/shared";
import { roles, rolesPermissions } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { name } = await params;
  const body = await req.json() as { label?: string; permissions?: string[] };

  const [role] = await db.select().from(roles).where(eq(roles.name, name)).limit(1);
  if (!role) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (body.label?.trim()) {
    await db.update(roles).set({ label: body.label.trim() }).where(eq(roles.name, name));
  }

  if (Array.isArray(body.permissions)) {
    await db.delete(rolesPermissions).where(eq(rolesPermissions.role, name));
    for (const p of body.permissions) {
      await db.insert(rolesPermissions).values({ role: name, permission: p });
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { name } = await params;
  const [role] = await db.select().from(roles).where(eq(roles.name, name)).limit(1);
  if (!role) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (role.isSystem) return NextResponse.json({ error: "cannot delete system role" }, { status: 400 });

  await db.delete(rolesPermissions).where(eq(rolesPermissions.role, name));
  await db.delete(roles).where(eq(roles.name, name));
  return NextResponse.json({ ok: true });
}
