import { redirect } from "next/navigation";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { SideMenu } from "@/components/SideMenu";
import { InvitesPanel } from "@/components/InvitesPanel";

export const dynamic = "force-dynamic";

export default async function InvitesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.permissions.has(PERMISSIONS.INVITES_CREATE)) redirect("/");

  return (
    <div className="flex">
      <SideMenu user={user} />
      <main className="flex-1 p-8">
        <h1 className="mb-1 text-2xl font-semibold">Invites</h1>
        <p className="mb-6 text-sm text-muted">
          Generate invite codes for new members. Codes look like{" "}
          <code className="text-accent">LGND#XXXXXX</code>.
        </p>
        <InvitesPanel
          canCreateElevated={user.permissions.has(PERMISSIONS.INVITES_CREATE_ELEVATED)}
        />
      </main>
    </div>
  );
}
