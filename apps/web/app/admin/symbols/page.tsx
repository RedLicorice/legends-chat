import { redirect } from "next/navigation";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { AdminSymbolsPanel } from "@/components/AdminSymbolsPanel";

export const dynamic = "force-dynamic";

export default async function AdminSymbolsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) redirect("/");

  return (
    <main className="flex-1 p-4 sm:p-8">
      <h1 className="mb-2 text-2xl font-semibold">Symbols</h1>
      <p className="mb-6 text-sm text-muted">Define $ticker symbols and link them to vendor users.</p>
      <AdminSymbolsPanel />
    </main>
  );
}
