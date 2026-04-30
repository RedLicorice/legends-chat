import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { PERMISSIONS } from "@legends/shared";
import { roles, rolesPermissions, topics } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

function parseTopicPerm(perm: string): { slug: string; action: "view" | "read" | "post" } | null {
  const m = perm.match(/^topic\.([^.]+)\.(view|read|post)$/);
  if (!m) return null;
  return { slug: m[1]!, action: m[2] as "view" | "read" | "post" };
}

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
    // Get old permissions before replacing
    const oldPerms = await db
      .select({ permission: rolesPermissions.permission })
      .from(rolesPermissions)
      .where(eq(rolesPermissions.role, name));
    const oldSet = new Set(oldPerms.map((p) => p.permission));
    const newSet = new Set(body.permissions);

    await db.delete(rolesPermissions).where(eq(rolesPermissions.role, name));
    for (const p of body.permissions) {
      await db.insert(rolesPermissions).values({ role: name, permission: p });
    }

    // Sync topic JSONB for any topic.* permission changes
    const added = body.permissions.filter((p) => !oldSet.has(p));
    const removed = [...oldSet].filter((p) => !newSet.has(p));

    for (const perm of added) {
      const parsed = parseTopicPerm(perm);
      if (!parsed) continue;
      const [topic] = await db.select().from(topics).where(eq(topics.slug, parsed.slug)).limit(1);
      if (!topic) continue;
      const col = parsed.action === "view" ? "viewRoles" : parsed.action === "read" ? "readRoles" : "postRoles";
      const current = (topic[col as keyof typeof topic] as string[] | null) ?? [];
      if (!current.includes(name)) {
        await db.update(topics)
          .set({ [col]: [...current, name] })
          .where(eq(topics.slug, parsed.slug));
      }
    }

    for (const perm of removed) {
      const parsed = parseTopicPerm(perm);
      if (!parsed) continue;
      const [topic] = await db.select().from(topics).where(eq(topics.slug, parsed.slug)).limit(1);
      if (!topic) continue;
      const col = parsed.action === "view" ? "viewRoles" : parsed.action === "read" ? "readRoles" : "postRoles";
      const current = (topic[col as keyof typeof topic] as string[] | null) ?? [];
      await db.update(topics)
        .set({ [col]: current.filter((r) => r !== name) })
        .where(eq(topics.slug, parsed.slug));
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
