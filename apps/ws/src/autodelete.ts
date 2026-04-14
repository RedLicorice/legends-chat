import { and, eq, isNull, lt, notInArray, sql } from "drizzle-orm";
import type { Server } from "socket.io";
import { messages, topics } from "@legends/db/schema";
import { WS_EVENTS } from "@legends/shared";
import { db } from "./db";

const TICK_MS = 60_000;

async function purgeAgeMode(io: Server): Promise<void> {
  const rows = await db
    .select()
    .from(topics)
    .where(eq(topics.autoDeleteMode, "age"));
  for (const t of rows) {
    if (!t.autoDeleteAgeSeconds || t.autoDeleteAgeSeconds <= 0) continue;
    const cutoff = new Date(Date.now() - t.autoDeleteAgeSeconds * 1000);
    const deleted = await db
      .delete(messages)
      .where(and(eq(messages.topicId, t.id), lt(messages.createdAt, cutoff)))
      .returning({ id: messages.id });
    if (deleted.length > 0) {
      console.log(`[autodelete] age: removed ${deleted.length} messages from topic ${t.slug}`);
      for (const d of deleted) {
        io.to(`topic:${t.id}`).emit(WS_EVENTS.MESSAGE_DELETE, { id: d.id.toString(), topicId: t.id });
      }
    }
  }
}

export async function purgeCountModeForTopic(io: Server, topicId: string, max: number): Promise<void> {
  if (max <= 0) return;
  // Find the ids of the most recent `max` messages, then delete the rest.
  const keepRows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.topicId, topicId), isNull(messages.deletedAt)))
    .orderBy(sql`${messages.id} desc`)
    .limit(max);
  if (keepRows.length < max) return;
  const keepIds = keepRows.map((r) => r.id);
  const deleted = await db
    .delete(messages)
    .where(and(eq(messages.topicId, topicId), notInArray(messages.id, keepIds)))
    .returning({ id: messages.id });
  for (const d of deleted) {
    io.to(`topic:${topicId}`).emit(WS_EVENTS.MESSAGE_DELETE, { id: d.id.toString(), topicId });
  }
}

export function startAutoDelete(io: Server): void {
  const tick = async () => {
    try {
      await purgeAgeMode(io);
    } catch (err) {
      console.error("[autodelete] tick failed", err);
    }
  };
  setTimeout(tick, 5_000);
  setInterval(tick, TICK_MS);
  console.log("[autodelete] worker started");
}
