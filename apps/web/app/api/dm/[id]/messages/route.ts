import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { REDIS_CHANNELS } from "@legends/shared";
import { dmConversations } from "@legends/db/schema";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { getCurrentUser } from "@/lib/auth";
import { assertParticipant, listMessages, insertDmMessage, recipientUserIds, isBlockedBetween } from "@/lib/dm";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await assertParticipant(id, user.id);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const beforeRaw = req.nextUrl.searchParams.get("before");
  const before = beforeRaw && /^\d+$/.test(beforeRaw) ? beforeRaw : undefined;
  const messages = await listMessages(id, before);
  return NextResponse.json({ messages });
}

const sendSchema = z.object({
  text: z.string().min(1).max(8000),
  replyToMessageId: z.string().regex(/^\d+$/).optional().nullable(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await assertParticipant(id, user.id);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsed = sendSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const [conv] = await db.select().from(dmConversations).where(eq(dmConversations.id, id)).limit(1);
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (conv.state === "blocked") return NextResponse.json({ error: "blocked" }, { status: 403 });
  if (conv.isE2ee) return NextResponse.json({ error: "e2ee send not supported in Plan A" }, { status: 400 });

  // double-check live block state between the two users
  const peers = await recipientUserIds(id, user.id);
  for (const p of peers) {
    if (await isBlockedBetween(user.id, p)) return NextResponse.json({ error: "blocked" }, { status: 403 });
  }

  const msg = await insertDmMessage({ conversationId: id, senderType: "user", senderId: user.id, text: parsed.data.text, replyToMessageId: parsed.data.replyToMessageId ?? null });

  // fan out via the ws relay: emit to each participant's user room
  const allParticipants = [user.id, ...peers];
  await redis.publish(REDIS_CHANNELS.DM_MESSAGE_NEW, JSON.stringify({ conversationId: id, message: msg, userIds: allParticipants }));
  return NextResponse.json({ message: msg }, { status: 201 });
}
