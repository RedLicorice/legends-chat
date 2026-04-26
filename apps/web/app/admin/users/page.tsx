import { redirect } from "next/navigation";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { AdminUsersForm } from "@/components/AdminUsersForm";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) redirect("/");

  return (
    <main className="flex-1 p-8">
      <h1 className="mb-2 text-2xl font-semibold">Users</h1>
      <p className="mb-6 text-sm text-muted">Search members and change their roles.</p>
      <AdminUsersForm currentUserId={user.id} />
    </main>
  );
}
