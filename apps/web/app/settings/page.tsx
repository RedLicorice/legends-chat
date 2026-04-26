import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { TotpPanel } from "@/components/TotpPanel";
import { ThemeSelector } from "@/components/ThemeSelector";
import { SidebarCompactSelector } from "@/components/SidebarCompactSelector";
import { getSetting } from "@legends/db/system-settings";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const jar = await cookies();
  const userTheme = jar.get("lc_theme")?.value;
  const userSidebarCompact = jar.get("lc_sidebar_compact")?.value;

  const [defaultTheme, sidebarCompactDefault] = await Promise.all([
    getSetting(db, "default_theme").catch(() => null),
    getSetting(db, "sidebar_compact_default").catch(() => null),
  ]);

  const currentTheme = userTheme ?? defaultTheme ?? "dark";
  const currentCompact = userSidebarCompact ?? sidebarCompactDefault ?? "minimal";

  return (
    <main className="flex min-h-screen items-start justify-center p-8">
      <div className="w-full max-w-lg space-y-8">
        <div>
          <Link
            href="/"
            className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text"
          >
            <ArrowLeft className="h-4 w-4" /> Back to chat
          </Link>
          <h1 className="text-2xl font-semibold">Account settings</h1>
          <p className="mt-1 text-sm text-muted">Manage your security and appearance preferences.</p>
        </div>

        <div className="rounded-xl border border-border bg-panel p-5 space-y-4">
          <h2 className="font-semibold">Appearance</h2>
          <ThemeSelector defaultTheme={currentTheme} />
          <SidebarCompactSelector defaultValue={currentCompact} />
        </div>

        <div className="rounded-xl border border-border bg-panel p-5">
          <TotpPanel />
        </div>
      </div>
    </main>
  );
}
