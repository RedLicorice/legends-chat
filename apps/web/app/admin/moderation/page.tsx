import { redirect } from "next/navigation";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { listPendingFlags } from "@/lib/moderation-queue";
import { SideMenu } from "@/components/SideMenu";
import { ModerationQueue } from "@/components/ModerationQueue";

export const dynamic = "force-dynamic";

export default async function ModerationPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.permissions.has(PERMISSIONS.MODERATION_QUEUE_REVIEW)) redirect("/");

  const flags = await listPendingFlags();
  const canBan = user.permissions.has(PERMISSIONS.USERS_BAN_DIRECT);
  const canMute = user.permissions.has(PERMISSIONS.USERS_MUTE_DIRECT);

  return (
    <div className="flex">
      <SideMenu user={user} />
      <main className="flex-1 p-8">
        <h1 className="mb-2 text-2xl font-semibold">Moderation queue</h1>
        <p className="mb-6 text-sm text-muted">
          {flags.length} pending flag{flags.length === 1 ? "" : "s"}
        </p>
        <ModerationQueue
          flags={flags.map((f) => ({
            ...f,
            createdAt: f.createdAt.toISOString(),
            message: { ...f.message, deletedAt: f.message.deletedAt?.toISOString() ?? null },
          }))}
          canBan={canBan}
          canMute={canMute}
        />
      </main>
    </div>
  );
}
