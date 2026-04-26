import { redirect } from "next/navigation";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { BansPanel } from "@/components/BansPanel";

export const dynamic = "force-dynamic";

export default async function AdminBansPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) redirect("/");

  return (
    <main className="flex-1 p-8 max-w-3xl">
      <h1 className="mb-2 text-2xl font-semibold">Bans & Mutes</h1>
      <p className="mb-6 text-sm text-muted">Active sanctions. Lift them to restore access.</p>
      <BansPanel />
    </main>
  );
}
