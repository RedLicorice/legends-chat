import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { inviteCodes } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.INVITES_CREATE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const isAdmin = user.permissions.has(PERMISSIONS.ADMIN_CONFIG);
  const [row] = await db.select({ createdByUserId: inviteCodes.createdByUserId }).from(inviteCodes).where(eq(inviteCodes.id, id)).limit(1);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!isAdmin && row.createdByUserId !== user.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  await db.delete(inviteCodes).where(eq(inviteCodes.id, id));
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.INVITES_CREATE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const isAdmin = user.permissions.has(PERMISSIONS.ADMIN_CONFIG);
  const [row] = await db.select({ createdByUserId: inviteCodes.createdByUserId, disabledAt: inviteCodes.disabledAt }).from(inviteCodes).where(eq(inviteCodes.id, id)).limit(1);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!isAdmin && row.createdByUserId !== user.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (typeof body.disabled === "boolean") {
    patch.disabledAt = body.disabled ? new Date() : null;
  }
  if ("notes" in body) {
    patch.notes = typeof body.notes === "string" ? body.notes.slice(0, 500) || null : null;
  }
  if (Object.keys(patch).length > 0) {
    await db.update(inviteCodes).set(patch).where(eq(inviteCodes.id, id));
  }
  return NextResponse.json({ ok: true });
}
