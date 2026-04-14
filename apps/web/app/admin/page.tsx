import { redirect } from "next/navigation";
import Link from "next/link";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { SideMenu } from "@/components/SideMenu";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.permissions.has(PERMISSIONS.MODERATION_QUEUE_REVIEW) && !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    redirect("/");
  }

  return (
    <div className="flex">
      <SideMenu user={user} />
      <main className="flex-1 p-8">
        <h1 className="mb-6 text-2xl font-semibold">Admin</h1>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card title="Topics" body="Create and configure community topics." />
          <Link href="/admin/invites" className="block">
            <Card title="Invites" body="Generate invite codes for new members." />
          </Link>
          <Link href="/admin/moderation" className="block">
            <Card title="Moderation queue" body="Review flagged messages." />
          </Link>
          <Card title="Bans & mutes" body="Manage active and historical sanctions." />
        </div>
        <p className="mt-8 text-sm text-muted">
          Endpoints in slice 1: <code>POST /api/admin/topics</code>, <code>POST /api/admin/invites</code>,
          <code> POST /api/admin/ban</code>, <code>POST /api/admin/mute</code>. UI for these lands in slice 1.5.
        </p>
      </main>
    </div>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-border bg-panel p-5">
      <h2 className="mb-1 font-semibold">{title}</h2>
      <p className="text-sm text-muted">{body}</p>
    </div>
  );
}
