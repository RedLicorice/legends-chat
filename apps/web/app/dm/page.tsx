import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listConversations } from "@/lib/dm";
import { DmClient } from "@/components/DmClient";

export const dynamic = "force-dynamic";

export default async function DmPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const conversations = await listConversations(user.id);
  return (
    <main className="h-[100dvh]">
      <DmClient initialConversations={conversations} currentUserId={user.id} />
    </main>
  );
}
