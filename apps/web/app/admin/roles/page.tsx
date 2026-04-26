import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { AdminRolesForm } from "@/components/AdminRolesForm";
import { db } from "@/lib/db";
import { roles, rolesPermissions } from "@legends/db/schema";

export const dynamic = "force-dynamic";

export default async function AdminRolesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) redirect("/");

  const allRoles = await db.select().from(roles).orderBy(asc(roles.sortOrder), asc(roles.name));
  const allPerms = await db.select().from(rolesPermissions);

  const permsByRole: Record<string, string[]> = {};
  for (const p of allPerms) {
    (permsByRole[p.role] ??= []).push(p.permission);
  }

  const roleData = allRoles.map((r) => ({
    name: r.name,
    label: r.label,
    isSystem: r.isSystem,
    sortOrder: r.sortOrder,
    permissions: permsByRole[r.name] ?? [],
  }));

  return (
    <main className="flex-1 p-4 sm:p-8">
      <h1 className="mb-2 text-2xl font-semibold">Roles</h1>
      <p className="mb-6 text-sm text-muted">
        Manage roles and their permissions. System roles (user, moderator, admin) cannot be deleted.
      </p>
      <AdminRolesForm roles={roleData} />
    </main>
  );
}
