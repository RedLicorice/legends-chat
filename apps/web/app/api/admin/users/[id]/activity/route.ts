import { and, count, desc, eq, isNotNull, max } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { messages, sessions, topicMembers, topics, userBans, userMutes } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export interface ActivityEvent {
  type:
    | "session_created"
    | "session_revoked"
    | "ban_applied"
    | "ban_lifted"
    | "mute_applied"
    | "mute_lifted"
    | "topic_joined"
    | "message_activity";
  timestamp: string;
  description: string;
  meta?: Record<string, string | number | null>;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor || !actor.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const rawLimit = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(Math.max(1, parseInt(rawLimit ?? "30", 10) || 30), 200);

  const [
    sessionRows,
    banRows,
    muteRows,
    memberRows,
    msgRows,
  ] = await Promise.all([
    // Sessions: both created and revoked events come from the same rows
    db
      .select({
        id: sessions.id,
        deviceLabel: sessions.deviceLabel,
        createdAt: sessions.createdAt,
        revokedAt: sessions.revokedAt,
      })
      .from(sessions)
      .where(eq(sessions.userId, id))
      .orderBy(desc(sessions.createdAt))
      .limit(limit),

    // Bans
    db
      .select({
        id: userBans.id,
        reason: userBans.reason,
        createdAt: userBans.createdAt,
        liftedAt: userBans.liftedAt,
      })
      .from(userBans)
      .where(eq(userBans.userId, id))
      .orderBy(desc(userBans.createdAt))
      .limit(limit),

    // Mutes
    db
      .select({
        id: userMutes.id,
        reason: userMutes.reason,
        createdAt: userMutes.createdAt,
        liftedAt: userMutes.liftedAt,
      })
      .from(userMutes)
      .where(eq(userMutes.userId, id))
      .orderBy(desc(userMutes.createdAt))
      .limit(limit),

    // Topic joins
    db
      .select({
        topicId: topicMembers.topicId,
        joinedAt: topicMembers.joinedAt,
        topicTitle: topics.title,
      })
      .from(topicMembers)
      .innerJoin(topics, eq(topics.id, topicMembers.topicId))
      .where(eq(topicMembers.userId, id))
      .orderBy(desc(topicMembers.joinedAt))
      .limit(limit),

    // Message activity: one aggregated event per topic
    db
      .select({
        topicId: messages.topicId,
        topicTitle: topics.title,
        messageCount: count(messages.id),
        lastAt: max(messages.createdAt),
      })
      .from(messages)
      .innerJoin(topics, eq(topics.id, messages.topicId))
      .where(
        and(
          eq(messages.senderUserId, id),
          isNotNull(messages.senderUserId),
        ),
      )
      .groupBy(messages.topicId, topics.title)
      .orderBy(desc(max(messages.createdAt)))
      .limit(limit),
  ]);

  const events: ActivityEvent[] = [];

  for (const s of sessionRows) {
    const label = s.deviceLabel ?? null;
    events.push({
      type: "session_created",
      timestamp: s.createdAt.toISOString(),
      description: label ? `Session created (${label})` : "Session created",
      meta: { deviceLabel: label },
    });
    if (s.revokedAt) {
      events.push({
        type: "session_revoked",
        timestamp: s.revokedAt.toISOString(),
        description: label ? `Session revoked (${label})` : "Session revoked",
        meta: { deviceLabel: label },
      });
    }
  }

  for (const b of banRows) {
    events.push({
      type: "ban_applied",
      timestamp: b.createdAt.toISOString(),
      description: `Ban applied: ${b.reason}`,
      meta: { reason: b.reason },
    });
    if (b.liftedAt) {
      events.push({
        type: "ban_lifted",
        timestamp: b.liftedAt.toISOString(),
        description: `Ban lifted: ${b.reason}`,
        meta: { reason: b.reason },
      });
    }
  }

  for (const m of muteRows) {
    events.push({
      type: "mute_applied",
      timestamp: m.createdAt.toISOString(),
      description: `Mute applied: ${m.reason}`,
      meta: { reason: m.reason },
    });
    if (m.liftedAt) {
      events.push({
        type: "mute_lifted",
        timestamp: m.liftedAt.toISOString(),
        description: `Mute lifted: ${m.reason}`,
        meta: { reason: m.reason },
      });
    }
  }

  for (const tm of memberRows) {
    events.push({
      type: "topic_joined",
      timestamp: tm.joinedAt.toISOString(),
      description: `Joined topic: ${tm.topicTitle}`,
      meta: { topicId: tm.topicId, topicTitle: tm.topicTitle },
    });
  }

  for (const msg of msgRows) {
    if (!msg.lastAt) continue;
    const lastAt = msg.lastAt instanceof Date ? msg.lastAt.toISOString() : String(msg.lastAt);
    events.push({
      type: "message_activity",
      timestamp: lastAt,
      description: `${msg.messageCount} message${Number(msg.messageCount) === 1 ? "" : "s"} in ${msg.topicTitle} (last: ${lastAt})`,
      meta: {
        topicId: msg.topicId,
        topicTitle: msg.topicTitle,
        messageCount: Number(msg.messageCount),
      },
    });
  }

  events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  const result = events.slice(0, limit);

  return NextResponse.json(result);
}
