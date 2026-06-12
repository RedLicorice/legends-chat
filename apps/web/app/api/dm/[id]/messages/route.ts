import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { REDIS_CHANNELS } from "@legends/shared";
import { dmConversations } from "@legends/db/schema";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { getCurrentUser } from "@/lib/auth";
import { assertParticipant, listMessages, insertDmMessage, recipientUserIds, isBlockedBetween } from "@/lib/dm";
import { deliverDmToBots } from "@/lib/dm-bot-delivery";

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
  const [conv] = await db
    .select({ isE2ee: dmConversations.isE2ee, e2eeRoomId: dmConversations.e2eeRoomId })
    .from(dmConversations)
    .where(eq(dmConversations.id, id))
    .limit(1);
  return NextResponse.json({
    messages,
    isE2ee: conv?.isE2ee ?? false,
    e2eeRoomId: conv?.e2eeRoomId ?? null,
  });
}

// Accept either plaintext (`text`) or an E2EE envelope (`ciphertext`), but not
// both. Convo.is_e2ee decides which is required; the per-row CHECK constraint
// enforces mutual exclusion at the DB level.
const sendSchema = z
  .object({
    text: z.string().min(1).max(8000).optional(),
    ciphertext: z.record(z.unknown()).optional(),
    replyToMessageId: z.string().regex(/^\d+$/).optional().nullable(),
  })
  .refine((d) => (d.text != null) !== (d.ciphertext != null), {
    message: "provide exactly one of `text` or `ciphertext`",
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

  // E2EE-vs-plaintext payload must match the conversation mode.
  if (conv.isE2ee && parsed.data.ciphertext == null) {
    return NextResponse.json({ error: "E2EE conversation; send ciphertext" }, { status: 400 });
  }
  if (!conv.isE2ee && parsed.data.text == null) {
    return NextResponse.json({ error: "plaintext conversation; send text" }, { status: 400 });
  }

  // double-check live block state between the two users
  const peers = await recipientUserIds(id, user.id);
  for (const p of peers) {
    if (await isBlockedBetween(user.id, p)) return NextResponse.json({ error: "blocked" }, { status: 403 });
  }

  const msg = await insertDmMessage({
    conversationId: id,
    senderType: "user",
    senderId: user.id,
    text: parsed.data.text,
    ciphertext: parsed.data.ciphertext,
    replyToMessageId: parsed.data.replyToMessageId ?? null,
  });

  // fan out via the ws relay: emit to each participant's user room
  const allParticipants = [user.id, ...peers];
  await redis.publish(
    REDIS_CHANNELS.DM_MESSAGE_NEW,
    JSON.stringify({ conversationId: id, message: msg, userIds: allParticipants, isE2ee: conv.isE2ee }),
  );

  // Dispatch to any bot participants of this conversation (Plan C). Fire for
  // BOTH plaintext and E2EE convos — bots that are members of an E2EE DM still
  // need the envelope so they can decrypt with their OlmMachine. The original
  // `!conv.isE2ee && text != null` gate silently dropped user→bot ciphertext,
  // which is the live-stack bug this reconciles. `deliverDmToBots` itself
  // routes plaintext vs ciphertext shape (Task 15 / dm-bot-delivery.ts).
  void deliverDmToBots(id, {
    id: msg.id,
    senderType: "user",
    senderId: user.id,
    senderDisplayName: user.displayName,
    text: parsed.data.text ?? "",
    ciphertext: parsed.data.ciphertext ?? null,
    replyToMessageId: parsed.data.replyToMessageId ?? null,
    createdAt: msg.createdAt,
  }).catch((e) => console.error("[dm-bot-delivery] failed", e));

  return NextResponse.json({ message: msg }, { status: 201 });
}
