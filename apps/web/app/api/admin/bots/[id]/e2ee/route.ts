import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bots,
  botDevices,
  botOneTimeKeys,
  botToDeviceQueue,
  botCryptoSentTxns,
  dmParticipants,
  topicBots,
  topicMembers,
} from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { logDeviceChange } from "@/lib/device-change-log";

const BodySchema = z.union([
  z.object({ enabled: z.boolean() }).strict(),
  z.object({ rotate: z.literal(true) }).strict(),
]);

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.BOTS_MANAGE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { id } = await params;

  const [row] = await db
    .select({ id: bots.id, e2eeState: bots.e2eeState, e2eeDeviceId: bots.e2eeDeviceId })
    .from(bots)
    .where(eq(bots.id, id))
    .limit(1);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if ("rotate" in parsed.data) {
    await db.transaction(async (tx) => {
      await tx.delete(botDevices).where(eq(botDevices.botId, id));
      await tx.delete(botOneTimeKeys).where(eq(botOneTimeKeys.botId, id));
      await tx.delete(botToDeviceQueue).where(eq(botToDeviceQueue.botId, id));
      await tx.delete(botCryptoSentTxns).where(eq(botCryptoSentTxns.botId, id));
      await tx
        .update(bots)
        .set({ e2eeState: "pending", e2eeDeviceId: null })
        .where(eq(bots.id, id))
        .returning();
    });

    // Finding 11: peers must drop their cached device set for the bot —
    // without a device-change nudge they keep encrypting Olm messages to the
    // dead device id. Find every user who shares an E2EE-capable surface with
    // the bot (DM participant OR topic member where the bot is a topic_bot)
    // and append one user_device_change_log row each. Mirrors the topic-
    // membership pattern from Task 16.
    //
    // Failures are swallowed by logDeviceChange itself — best-effort, so the
    // rotate transaction's success isn't blocked by a logging issue.
    const peerUserIds = new Set<string>();

    // 1. Users that share a DM conversation with the bot.
    const botConvs = await db
      .select({ conversationId: dmParticipants.conversationId })
      .from(dmParticipants)
      .where(
        and(
          eq(dmParticipants.principalType, "bot"),
          eq(dmParticipants.principalId, id),
        ),
      );
    if (botConvs.length > 0) {
      const convIds = botConvs.map((c) => c.conversationId);
      const userParts = await db
        .select({ pid: dmParticipants.principalId })
        .from(dmParticipants)
        .where(
          and(
            inArray(dmParticipants.conversationId, convIds),
            eq(dmParticipants.principalType, "user"),
          ),
        );
      for (const u of userParts) peerUserIds.add(u.pid);
    }

    // 2. Users that share a topic with the bot.
    const botTopics = await db
      .select({ topicId: topicBots.topicId })
      .from(topicBots)
      .where(eq(topicBots.botId, id));
    if (botTopics.length > 0) {
      const topicIds = botTopics.map((t) => t.topicId);
      const members = await db
        .select({ userId: topicMembers.userId })
        .from(topicMembers)
        .where(inArray(topicMembers.topicId, topicIds));
      for (const m of members) peerUserIds.add(m.userId);
    }

    for (const userId of peerUserIds) {
      await logDeviceChange(userId, `bot_rotate:${id}`);
    }

    return NextResponse.json({ id, e2ee_state: "pending", e2ee_device_id: null });
  }

  const enabled = parsed.data.enabled;
  if (enabled) {
    if (row.e2eeState === "disabled") {
      await db
        .update(bots)
        .set({ e2eeState: "pending" })
        .where(eq(bots.id, id))
        .returning();
      return NextResponse.json({ id, e2ee_state: "pending", e2ee_device_id: row.e2eeDeviceId });
    }
    // pending or ready: no-op
    return NextResponse.json({ id, e2ee_state: row.e2eeState, e2ee_device_id: row.e2eeDeviceId });
  }

  // enabled === false: only flip state; keep device row + device_id intact
  if (row.e2eeState !== "disabled") {
    await db
      .update(bots)
      .set({ e2eeState: "disabled" })
      .where(eq(bots.id, id))
      .returning();
  }
  return NextResponse.json({ id, e2ee_state: "disabled", e2ee_device_id: row.e2eeDeviceId });
}
