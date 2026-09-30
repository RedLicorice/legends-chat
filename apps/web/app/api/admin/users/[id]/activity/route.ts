import { and, count, desc, eq, isNotNull, max, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { NextResponse, type NextRequest } from "next/server";
import { auditLog, messages, sessions, topicMembers, topics, userBans, userMutes, users } from "@legends/db/schema";
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
    | "message_activity"
    | "audit_action";
  timestamp: string;
  description: string;
  meta?: Record<string, string | number | null>;
  /** cr-m10: who performed the action, when the event has a distinct actor. */
  actor?: { id: string; displayName: string } | null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor || !actor.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const rawLimit = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(Math.max(1, parseInt(rawLimit ?? "30", 10) || 30), 200);

  // cr-m10: ban/mute rows have carried banned_by_user_id / muted_by_user_id /
  // lifted_by_user_id since day one, but this route never selected them, so
  // "which admin did this" was unanswerable from the UI despite the data being
  // right there. Join the actors in.
  const banActor = alias(users, "ban_actor");
  const banLifter = alias(users, "ban_lifter");
  const muteActor = alias(users, "mute_actor");
  const muteLifter = alias(users, "mute_lifter");
  const auditActor = alias(users, "audit_actor");

  const [
    sessionRows,
    banRows,
    muteRows,
    memberRows,
    msgRows,
    auditRows,
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
        actorId: banActor.id,
        actorName: banActor.displayName,
        lifterId: banLifter.id,
        lifterName: banLifter.displayName,
      })
      .from(userBans)
      .leftJoin(banActor, eq(banActor.id, userBans.bannedByUserId))
      .leftJoin(banLifter, eq(banLifter.id, userBans.liftedByUserId))
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
        actorId: muteActor.id,
        actorName: muteActor.displayName,
        lifterId: muteLifter.id,
        lifterName: muteLifter.displayName,
      })
      .from(userMutes)
      .leftJoin(muteActor, eq(muteActor.id, userMutes.mutedByUserId))
      .leftJoin(muteLifter, eq(muteLifter.id, userMutes.liftedByUserId))
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

    // cr-m10: the real append-only record. Everything this user did as an
    // admin, and everything an admin did TO them — including message deletion,
    // which had no representation here at all.
    db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt,
        actorId: auditActor.id,
        actorName: auditActor.displayName,
      })
      .from(auditLog)
      .leftJoin(auditActor, eq(auditActor.id, auditLog.actorUserId))
      .where(
        or(
          eq(auditLog.actorUserId, id),
          and(eq(auditLog.targetType, "user"), eq(auditLog.targetId, id)),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
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
    const by = b.actorId && b.actorName ? { id: b.actorId, displayName: b.actorName } : null;
    events.push({
      type: "ban_applied",
      timestamp: b.createdAt.toISOString(),
      description: by ? `Ban applied by ${by.displayName}: ${b.reason}` : `Ban applied: ${b.reason}`,
      meta: { reason: b.reason },
      actor: by,
    });
    if (b.liftedAt) {
      const lifter = b.lifterId && b.lifterName ? { id: b.lifterId, displayName: b.lifterName } : null;
      events.push({
        type: "ban_lifted",
        timestamp: b.liftedAt.toISOString(),
        description: lifter ? `Ban lifted by ${lifter.displayName}: ${b.reason}` : `Ban lifted: ${b.reason}`,
        meta: { reason: b.reason },
        actor: lifter,
      });
    }
  }

  for (const m of muteRows) {
    const by = m.actorId && m.actorName ? { id: m.actorId, displayName: m.actorName } : null;
    events.push({
      type: "mute_applied",
      timestamp: m.createdAt.toISOString(),
      description: by ? `Mute applied by ${by.displayName}: ${m.reason}` : `Mute applied: ${m.reason}`,
      meta: { reason: m.reason },
      actor: by,
    });
    if (m.liftedAt) {
      const lifter = m.lifterId && m.lifterName ? { id: m.lifterId, displayName: m.lifterName } : null;
      events.push({
        type: "mute_lifted",
        timestamp: m.liftedAt.toISOString(),
        description: lifter ? `Mute lifted by ${lifter.displayName}: ${m.reason}` : `Mute lifted: ${m.reason}`,
        meta: { reason: m.reason },
        actor: lifter,
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

  for (const a of auditRows) {
    const by = a.actorId && a.actorName ? { id: a.actorId, displayName: a.actorName } : null;
    const target = a.targetType && a.targetId ? ` ${a.targetType} ${a.targetId}` : "";
    events.push({
      type: "audit_action",
      timestamp: a.createdAt.toISOString(),
      description: `${by ? by.displayName : "system"}: ${a.action}${target}`,
      meta: {
        action: a.action,
        targetType: a.targetType,
        targetId: a.targetId,
        metadata: a.metadata ? JSON.stringify(a.metadata) : null,
      },
      actor: by,
    });
  }

  events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  const result = events.slice(0, limit);

  return NextResponse.json(result);
}
