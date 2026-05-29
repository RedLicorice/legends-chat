import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { dmConversations, dmBlocks } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { assertParticipant, recipientUserIds } from "@/lib/dm";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await assertParticipant(id, user.id);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const peers = await recipientUserIds(id, user.id);
  for (const p of peers) {
    await db.insert(dmBlocks).values({ blockerUserId: user.id, blockedUserId: p }).onConflictDoNothing();
  }
  await db.update(dmConversations).set({ state: "blocked" }).where(eq(dmConversations.id, id));
  return NextResponse.json({ ok: true });
}
