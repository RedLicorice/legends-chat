import { redirect } from "next/navigation";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { AdminSettingsForm } from "@/components/AdminSettingsForm";
import { db } from "@/lib/db";
import { getAllSettings } from "@legends/db/system-settings";
import { topics } from "@legends/db/schema";
import { asc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) redirect("/");

  const [settings, topicList] = await Promise.all([
    getAllSettings(db),
    db.select({ id: topics.id, title: topics.title, slug: topics.slug }).from(topics).orderBy(asc(topics.sortOrder)),
  ]);

  return (
    <main className="flex-1 p-8 max-w-xl">
      <h1 className="mb-2 text-2xl font-semibold">Community Settings</h1>
      <p className="mb-6 text-sm text-muted">Configure the default channel and automated system messages.</p>
      <AdminSettingsForm settings={settings} topics={topicList} />
    </main>
  );
}
