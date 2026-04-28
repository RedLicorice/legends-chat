import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AppSidebar, AdminNav } from "@/components/AppSidebar";
import { PERMISSIONS } from "@legends/shared";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.permissions.has(PERMISSIONS.MODERATION_QUEUE_REVIEW) && !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    redirect("/");
  }

  const permissions = Array.from(user.permissions);

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      <AppSidebar
        user={{
          id: user.id,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl ?? null,
          role: user.role,
          permissions,
        }}
        variant="admin"
      >
        <AdminNav permissions={permissions} />
      </AppSidebar>
      <div className="selectable flex flex-1 flex-col overflow-y-auto pt-14 md:pt-0">
        {children}
      </div>
    </div>
  );
}
