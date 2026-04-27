import { redirect } from "next/navigation";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { AdminNotificationsForm } from "@/components/AdminNotificationsForm";

export const dynamic = "force-dynamic";

export default async function AdminNotificationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) redirect("/");

  return (
    <main className="flex-1 p-4 sm:p-8 max-w-2xl">
      <h1 className="mb-2 text-2xl font-semibold">Broadcast Notifications</h1>
      <p className="mb-6 text-sm text-muted">Send a system notification to all users or a specific role.</p>
      <AdminNotificationsForm />
    </main>
  );
}
