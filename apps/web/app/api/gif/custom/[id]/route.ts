import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { PERMISSIONS } from "@legends/shared";
import { customGifs } from "@legends/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const isAdmin = user.permissions.has(PERMISSIONS.ADMIN_CONFIG);
  const canUpload = user.permissions.has(PERMISSIONS.CONTENT_GIF_UPLOAD);
  if (!isAdmin && !canUpload) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await req.json() as { title?: string; tags?: string[] };

  const [existing] = await db.select().from(customGifs).where(eq(customGifs.id, id)).limit(1);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Non-admins can only edit their own uploads
  if (!isAdmin && existing.uploadedByUserId !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const updates: Partial<typeof existing> = {};
  if (body.title !== undefined) updates.title = body.title.trim();
  if (body.tags !== undefined) updates.tags = body.tags.map((t) => t.trim().toLowerCase()).filter(Boolean);

  const [updated] = await db.update(customGifs).set(updates).where(eq(customGifs.id, id)).returning();
  return NextResponse.json({ gif: updated });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const isAdmin = user.permissions.has(PERMISSIONS.ADMIN_CONFIG);
  const canUpload = user.permissions.has(PERMISSIONS.CONTENT_GIF_UPLOAD);
  if (!isAdmin && !canUpload) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const [existing] = await db.select().from(customGifs).where(eq(customGifs.id, id)).limit(1);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (!isAdmin && existing.uploadedByUserId !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await db.delete(customGifs).where(eq(customGifs.id, id));
  return NextResponse.json({ ok: true });
}
