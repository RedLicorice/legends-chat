import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { dmConversations } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { assertParticipant } from "@/lib/dm";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await assertParticipant(id, user.id);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // only the recipient (non-initiator) accepts; initiator accept is a no-op
  const [conv] = await db.select().from(dmConversations).where(eq(dmConversations.id, id)).limit(1);
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (conv.state === "pending" && conv.initiatorId !== user.id) {
    await db.update(dmConversations).set({ state: "accepted" }).where(eq(dmConversations.id, id));
  }
  return NextResponse.json({ ok: true });
}
