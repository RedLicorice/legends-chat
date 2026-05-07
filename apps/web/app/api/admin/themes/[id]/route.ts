import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { PERMISSIONS } from "@legends/shared";
import { themes } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { setSetting } from "@legends/db/system-settings";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json() as {
    name?: string;
    colors?: Record<string, string>;
    isGlass?: boolean;
    bgGradient?: string | null;
    customCss?: string | null;
    setDefault?: boolean;
  };

  const [theme] = await db.select().from(themes).where(eq(themes.id, id)).limit(1);
  if (!theme) return NextResponse.json({ error: "not found" }, { status: 404 });

  const patch: Record<string, unknown> = {};
  if (body.name?.trim()) patch.name = body.name.trim();
  if (body.colors) patch.colors = body.colors;
  if (typeof body.isGlass === "boolean") patch.isGlass = body.isGlass;
  if ("bgGradient" in body) patch.bgGradient = body.bgGradient ?? null;
  if ("customCss" in body) patch.customCss = body.customCss ?? null;

  if (Object.keys(patch).length > 0) {
    await db.update(themes).set(patch).where(eq(themes.id, id));
  }

  if (body.setDefault) {
    await setSetting(db, "default_theme", id);
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const [theme] = await db.select().from(themes).where(eq(themes.id, id)).limit(1);
  if (!theme) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (theme.isBuiltin) return NextResponse.json({ error: "cannot delete builtin theme" }, { status: 400 });

  await db.delete(themes).where(eq(themes.id, id));
  return NextResponse.json({ ok: true });
}
