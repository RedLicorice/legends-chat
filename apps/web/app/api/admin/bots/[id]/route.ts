import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { bots } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.BOTS_MANAGE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json() as { name?: string; avatarUrl?: string | null; description?: string | null; webhookUrl?: string | null; isActive?: boolean };
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if ("avatarUrl" in body) patch.avatarUrl = body.avatarUrl ?? null;
  if ("description" in body) patch.description = body.description ?? null;
  if ("webhookUrl" in body) patch.webhookUrl = body.webhookUrl ?? null;
  if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  const [updated] = await db.update(bots).set(patch).where(eq(bots.id, id)).returning();
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ bot: updated });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.BOTS_MANAGE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  await db.delete(bots).where(eq(bots.id, id));
  return NextResponse.json({ ok: true });
}
