import { NextResponse } from "next/server";
import { eq, asc } from "drizzle-orm";
import { PERMISSIONS } from "@legends/shared";
import { roles, rolesPermissions } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const allRoles = await db.select().from(roles).orderBy(asc(roles.sortOrder), asc(roles.name));
  const allPerms = await db.select().from(rolesPermissions);

  const permsByRole: Record<string, string[]> = {};
  for (const p of allPerms) {
    (permsByRole[p.role] ??= []).push(p.permission);
  }

  return NextResponse.json(
    allRoles.map((r) => ({
      name: r.name,
      label: r.label,
      isSystem: r.isSystem,
      sortOrder: r.sortOrder,
      permissions: permsByRole[r.name] ?? [],
    })),
  );
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json() as {
    name: string;
    label: string;
    cloneFrom?: string;
    permissions?: string[];
  };

  const name = body.name?.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!body.label?.trim()) return NextResponse.json({ error: "label required" }, { status: 400 });

  const existing = await db.select().from(roles).where(eq(roles.name, name)).limit(1);
  if (existing.length > 0) return NextResponse.json({ error: "role already exists" }, { status: 409 });

  await db.insert(roles).values({ name, label: body.label.trim(), isSystem: false });

  let permsToInsert: string[] = [];
  if (body.permissions) {
    permsToInsert = body.permissions;
  } else if (body.cloneFrom) {
    const cloned = await db.select({ permission: rolesPermissions.permission }).from(rolesPermissions).where(eq(rolesPermissions.role, body.cloneFrom));
    permsToInsert = cloned.map((p) => p.permission);
  }

  for (const p of permsToInsert) {
    await db.insert(rolesPermissions).values({ role: name, permission: p }).onConflictDoNothing();
  }

  const newRole = await db.select().from(roles).where(eq(roles.name, name)).limit(1);
  return NextResponse.json({ role: newRole[0], permissions: permsToInsert }, { status: 201 });
}
