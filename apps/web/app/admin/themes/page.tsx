import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { AdminThemesForm } from "@/components/AdminThemesForm";
import { db } from "@/lib/db";
import { themes } from "@legends/db/schema";
import { getSetting } from "@legends/db/system-settings";

export const dynamic = "force-dynamic";

export default async function AdminThemesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) redirect("/");

  const [themeRows, defaultTheme] = await Promise.all([
    db.select().from(themes).orderBy(asc(themes.createdAt)),
    getSetting(db, "default_theme"),
  ]);

  return (
    <main className="flex-1 p-4 sm:p-8">
      <h1 className="mb-2 text-2xl font-semibold">Themes</h1>
      <p className="mb-6 text-sm text-muted">
        Create and edit themes. Users can pick any theme in their settings; the default applies to everyone else.
      </p>
      <AdminThemesForm
        themes={themeRows.map((t) => ({
          id: t.id,
          name: t.name,
          isBuiltin: t.isBuiltin,
          colors: (t.colors as Record<string, string>) ?? {},
          isGlass: t.isGlass,
          bgGradient: t.bgGradient ?? "",
        }))}
        defaultTheme={defaultTheme ?? "dark"}
      />
    </main>
  );
}
