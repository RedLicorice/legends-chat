import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { messageFlags, messages } from "@legends/db/schema";
import { PERMISSIONS, banReasonSchema } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { banUser, muteUser } from "@/lib/moderation";
import { resolveFlag, softDeleteMessage } from "@/lib/moderation-queue";

const dismissSchema = z.object({ action: z.literal("dismiss") });
const deleteSchema = z.object({ action: z.literal("delete") });
const banSchema = z.object({
  action: z.literal("ban"),
  reason: banReasonSchema,
  durationSeconds: z.number().int().positive().nullable(),
});
const muteSchema = z.object({
  action: z.literal("mute"),
  reason: banReasonSchema,
  durationSeconds: z.number().int().positive().nullable(),
});
const bodySchema = z.discriminatedUnion("action", [dismissSchema, deleteSchema, banSchema, muteSchema]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.MODERATION_QUEUE_REVIEW)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id: flagId } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const [flag] = await db
    .select()
    .from(messageFlags)
    .where(eq(messageFlags.id, flagId))
    .limit(1);
  if (!flag) return NextResponse.json({ error: "flag not found" }, { status: 404 });
  if (flag.status !== "pending") {
    return NextResponse.json({ error: "flag already resolved" }, { status: 409 });
  }

  const body = parsed.data;
  if (body.action === "dismiss") {
    await resolveFlag({ flagId, reviewerUserId: user.id, status: "dismissed" });
    return NextResponse.json({ ok: true });
  }

  // All non-dismiss actions soft-delete the offending message.
  await softDeleteMessage(flag.messageId.toString());
  await resolveFlag({ flagId, reviewerUserId: user.id, status: "actioned" });

  if (body.action === "ban") {
    if (!user.permissions.has(PERMISSIONS.USERS_BAN_DIRECT)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    // Need the offender's userId — the message may have a null sender (bot).
    const [m] = await db
      .select({ senderUserId: messages.senderUserId })
      .from(messages)
      .where(eq(messages.id, flag.messageId))
      .limit(1);
    if (!m?.senderUserId) return NextResponse.json({ ok: true, note: "message has no human sender" });
    const expiresAt = body.durationSeconds === null ? null : new Date(Date.now() + body.durationSeconds * 1000);
    await banUser({
      userId: m.senderUserId,
      bannedByUserId: user.id,
      reason: body.reason,
      expiresAt,
      sourceFlagId: flag.id,
    });
  } else if (body.action === "mute") {
    if (!user.permissions.has(PERMISSIONS.USERS_MUTE_DIRECT)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const [m] = await db
      .select({ senderUserId: messages.senderUserId })
      .from(messages)
      .where(eq(messages.id, flag.messageId))
      .limit(1);
    if (!m?.senderUserId) return NextResponse.json({ ok: true, note: "message has no human sender" });
    const expiresAt = body.durationSeconds === null ? null : new Date(Date.now() + body.durationSeconds * 1000);
    await muteUser({
      userId: m.senderUserId,
      mutedByUserId: user.id,
      reason: body.reason,
      expiresAt,
      sourceFlagId: flag.id,
    });
  }

  return NextResponse.json({ ok: true });
}
